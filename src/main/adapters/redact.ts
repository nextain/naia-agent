// adapters/redact — 로그/진단 출력에서 **시크릿(API 키·토큰)을 마스킹**. 평문 자격증명이 stderr 진단 로그에
// 새어 나가는 것을 막는다(보안 — OSS 공개 레포·공유 로그). DiagnosticLog sink(diagnostic.ts)가 write 직전 적용.
//
// 패턴은 `naia-settings-store.ts` 의 `RAW_SECRET_VALUE` 와 동족이다(거기 = git-tracked llm.json 거부 트리거 /
// 여기 = 출력 텍스트 마스킹). 의도·플래그(/g)가 달라 각자 보유 — 신규 키 패턴은 양쪽에 추가.
// 순수(Node/transport 0) — domain 만큼 무의존이나 로깅 어댑터 전용 유틸이라 adapters 에 둔다(import-boundary 무관).
//
// ⚠️ 범위 = **보수적 안전망(defense-in-depth)**, 완벽한 DLP 가 아니다. 1차 방어는 "비밀 값은 로그 금지 — 이름만"
//   규율(docs/logging.md). 이건 실수로 message/ctx 에 섞인 흔한 credential 형태를 best-effort 마스킹할 뿐 —
//   알려진 prefix + 흔한 키명 문맥만 잡고, 임의 키명·고엔트로피 무명 토큰은 보장 못 한다(과마스킹 회피 트레이드오프).
//   적대 크로스리뷰 7라운드(codex) 통과: prefix·키문맥·escaped-quote·JSON-key·quote보존·unquoted-trivial 가드·credential 토큰명.

const MASK = "[REDACTED]";

/** (1) prefix 기반 — 고유 prefix 로 문맥 없이도 식별되는 토큰. (적대리뷰 2026-06-23: xapp- 추가) */
const PREFIX_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic sk-ant-api03-…
  /AIza[0-9A-Za-z_-]{10,}/g, // Google API key
  /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, // GitHub token / PAT
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack bot/user/… token
  /\bxapp-[A-Za-z0-9-]{8,}/g, // Slack app-level token (codex #2)
  /\bAKIA[0-9A-Z]{12,}/g, // AWS access key id
  /\bgw-[A-Za-z0-9_-]{8,}/g, // naia gateway key (naiaKey)
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT (header.payload.sig)
];

// (2) 키-이름 문맥 기반 — prefix 없는 시크릿(apiKey=…, password: …, aws_secret_access_key=…)의 **값을 통째**
//   마스킹(codex #1 suffix 노출·#3 AWS secret·#4 무prefix). 오탐 억제: **= 또는 : 할당 문맥만**(prose 의 단순
//   공백 뒤 단어는 안 건드림 — "password reset" 의 reset 보존). 값 = 따옴표 블록 또는 공백/구분자 전까지(전 charset).
// core 키명(구체적인 것 먼저 — secret_access_key 가 access_key 보다 우선). 식별자 prefix 허용(lazy)로
//   `aws_secret_access_key` 같은 접두 식별자도 잡음(codex R1#3). value 는 escaped-quote 처리(codex R2#1 — JSON
//   로그 `"a\"b"` 우회 방지). ⚠️ bare `token`·`secret` 는 **제외**(codex R2#2 과마스킹 — `next_token=`·`page_token=`·
//   `secret: false`·`cancellationToken:` 등 정상 로그 파괴) — 구체 키명(client_secret·access_token·secret_access_key
//   ·api_key·password 등)만. authorization 은 Bearer 전용 패턴이 처리(이중마스킹 회피).
//   sep 은 키의 **닫는 따옴표**(JSON `"access_token":"…"`)를 optional 로 허용(codex R3 — quoted key 우회 방지).
//   credential 성격 토큰명만 열거(refresh/session/id/access/auth token) — pagination 류(next_token/page_token)는 제외(과마스킹 방지, codex R2·R6).
const KEY_VALUE_PATTERN =
  /\b([A-Za-z0-9_.-]*?(?:secret[_-]?access[_-]?key|access[_-]?key|client[_-]?secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|password|passwd|pwd))(["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi;
// 값이 명백한 비-시크릿(불리언/숫자/null)이면 마스킹 안 함(codex R2#2 — `apikey: null`·`x: false`·`count=42` 보존).
// ⚠️ **unquoted 만** trivial — quoted 값("123456")은 사용자가 의도적으로 문자열 credential 로 둔 것이라 마스킹(codex R5).
const TRIVIAL_VALUE = /^(?:true|false|null|none|undefined|\d+)$/i;
// (3) Authorization: Bearer <token> — prefix 없는 bearer 토큰(전 charset, base64/url-safe 포함).
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/**
 * 입력 텍스트에서 알려진 시크릿(고유 prefix 토큰 + 키-이름 문맥 값 + Bearer)을 `[REDACTED]` 로 치환.
 * 매치 없으면 원문 그대로(무손실). non-string 은 String() 변환(로깅 경로 never-throws).
 */
export function redactSecrets(input: string): string {
  let out = typeof input === "string" ? input : String(input);
  out = out.replace(BEARER_PATTERN, `Bearer ${MASK}`);
  out = out.replace(KEY_VALUE_PATTERN, (m: string, key: string, sep: string, val: string) => {
    if (TRIVIAL_VALUE.test(val)) return m; // 불리언/숫자/null = 비-시크릿, 보존
    // 값이 따옴표로 감싸였으면 wrapper 를 보존해 마스킹 — 구조화 JSON/YAML 로그가 깨지지 않게(codex R4).
    //   "access_token":"secret" → "access_token":"[REDACTED]" (valid JSON 유지).
    const q = val[0] === '"' || val[0] === "'" ? val[0] : "";
    return `${key}${sep}${q}${MASK}${q}`;
  });
  for (const re of PREFIX_PATTERNS) out = out.replace(re, MASK);
  return out;
}
