# cleanroom deep audit (bait pattern) — ref-cc-cleanroom

**대상**: ghuntley/claude-code-source-code-deobfuscation (commit ced7586, 2025-03)
**audit 일자**: 2026-04-25
**관점**: paranoid — "낚는 코드 / bait pattern" 발굴
**baseline**: `cc-cleanroom-security-audit-2026-04-25.md` (이전 audit, F1~F4)

## 종합 결론

cleanroom은 **악성코드(exfiltration / 백도어 / typosquat / 난독화)는 여전히 0건**이다.
모든 외부 fetch는 `api.anthropic.com`, `auth.anthropic.com`, `telemetry.anthropic.com`,
`localhost:3000/callback` 4개로만 한정되며, 의존성 lock도 정식 패키지 정합성을 유지한다.
이 점에서 **submodule로 두고 read-only 참고**하는 현 운영(매트릭스 §B04 F04)은 안전하다.

다만 **"낚는 코드"라는 우려는 정확하다**. 이전 audit의 F1~F4 외에 paranoid 관점에서
재조사한 결과 **8건의 추가 bait pattern (F5~F12)** 이 발견됐고, 그 중 **F5는 RCE 등급**
(고의 백도어가 아니라 LLM 환각으로 보이지만 따라하면 RCE), F6~F8은 "production-ready
처럼 export됐지만 실제로는 stub인데 그 사실이 코드 외형에서 잘 안 드러남" 유형의
전형적 bait이다. F2(PKCE)와 F3(path traversal)은 **고의 stub**(주석으로 "this is not
secure!" 자백, README가 학습용 명시)이지만 F5/F6/F7은 **고의가 아니라 LLM 재구성
중의 silent drift** 로 판정된다 — 더 위험한 종류다. 왜냐하면 자백 주석 없이 표준
패턴처럼 보이기 때문.

**차용 가이드**: 패턴(모듈 경계, 에러 카테고리, 명령 등록 구조 등)만 차용하고 **코드
라인은 한 줄도 복붙하지 말 것**. 특히 `auth/*`, `config/index.ts`, `telemetry/*`,
`commands/register.ts`의 exec 핸들러는 **참고조차 하지 말고** RFC/Anthropic SDK 공식
문서로 직접 작성. 매트릭스 §B04를 그대로 유지하되 본 보고서 ID(F5~F12)를 ticket
이유로 명시.

## 외부 endpoint 화이트리스트

| 도메인/URL | 등장 위치 | 정상? | 비고 |
|---|---|:---:|---|
| `https://api.anthropic.com` | `config/index.ts:21`, `config/defaults.ts:19`, `ai/client.ts:83` | ✓ | 정식 |
| `https://auth.anthropic.com/oauth2/auth` | `auth/oauth.ts:20` | ✓ | OAuth endpoint (실제 호출은 stub) |
| `https://auth.anthropic.com/oauth2/token` | `auth/oauth.ts:21` | ✓ | 동일 |
| `http://localhost:3000/callback` | `auth/oauth.ts:22` | ✓ | OAuth redirect (server 미구현) |
| `https://telemetry.anthropic.com/claude-code/events` | `telemetry/index.ts:110` | ⚠️ | 실재 도메인이나 endpoint 경로는 미검증. 사용자가 override 불가(F7) |
| `https://ghuntley.com/tradecraft` | `README.md:7` | ✓ | 저자 사이트 (subscribers only) |
| `https://docs.anthropic.com/...` | `scripts/preinstall.js:15` | ✓ | 도움말 링크만 |
| `https://nodejs.org` | `scripts/preinstall.js:25` | ✓ | 도움말 링크만 |

**판정**: 의심 endpoint 0. 다만 `telemetry.anthropic.com` 실재 endpoint인지는 외부
검증 필요(공개 docs에 등재되지 않음). cleanroom 자체가 잘못된 경로를 추측해 박았을
가능성 있음 — 차용 시 **이 endpoint는 신뢰하지 말 것**.

## bait pattern 발견 (F5~F12)

| ID | 위치 | 종류 | 심각도 | 분석 |
|---|---|---|:---:|---|
| F5 | `config/index.ts:114` | 임의 코드 실행 (RCE) | 🔴 high | `loadConfigFromFile`이 `.claude-code.js`이면 `require(configPath)`. CONFIG_PATHS에 `process.cwd()` 포함 → 사용자가 특정 디렉토리에서 CLI 실행 시 그 디렉토리의 `.claude-code.js`가 자동 실행. 표준 config-loader 외형이지만 JS 분기를 둔 게 함정. **차용하면 즉시 RCE.** |
| F6 | `ai/client.ts:123` | 인증 헤더 오용 | 🟠 medium | `getHeaders()`가 `'X-Api-Key': this.authToken`으로 hard-coded. AuthManager는 OAuth Bearer token까지 같은 `authToken` 슬롯에 채움(`getAuthorizationHeader` 따로 있음에도). 결과: OAuth 흐름 자체가 `X-Api-Key`로 잘못 송신 → 401 보장 + Bearer 토큰을 잘못된 헤더로 노출. Anthropic API spec과 모순. |
| F7 | `config/index.ts:152` vs `telemetry/index.ts:142` | env-var 키 drift | 🟠 medium | telemetry opt-out env-var이 `CLAUDE_TELEMETRY` (config) 와 `CLAUDE_CODE_TELEMETRY` (telemetry) 로 **불일치**. 둘 중 하나만 설정한 사용자는 opt-out 실패. + 기본값 `enabled: true` + endpoint를 사용자가 override 불가(`DEFAULT_CONFIG`에 박힘). 즉 "기본 켜짐, opt-out 어려움" 안티패턴. |
| F8 | `auth/tokens.ts:13` | secure storage 위장 stub | 🟠 medium | `createTokenStorage()`가 단순 in-memory `Map<string, AuthToken>` 반환. JSDoc은 "real implementation would use OS keychain or encrypted file storage" 주석으로 자백하지만 함수 시그니처는 `TokenStorage` 인터페이스를 그대로 만족 → 호출부에서 stub인지 알 수 없음. 차용자가 그대로 쓰면 매 프로세스마다 토큰 분실 + 공격자가 `Map` 인스턴스 접근만으로 평문 토큰 획득. |
| F9 | `auth/manager.ts:236-240` | 만료 없는 토큰 캐스팅 | 🟡 low | API key 인증 시 `expiresAt: Number.MAX_SAFE_INTEGER` 박아 영원 valid. revoke 감지 / rotation 메커니즘 0. 차용 시 stale credential 무한 재사용. |
| F10 | `utils/validation.ts:104` | 사용 안 되는 약한 path validator | 🟡 low | `isValidPath`가 `[a-zA-Z0-9\/\\\._\-~]+`만 허용 — UTF-8/공백/대부분 정상 path 거부. 본인은 fileops에서 안 쓰이지만 export됨 → 차용자가 "공식 path validator"로 오인 사용 위험. + null byte (`\x00`), drive letter (`:`) 모두 통과해 위험한 path도 통과 가능. |
| F11 | `telemetry/index.ts:430-432` | silent event drop | 🟡 low | `flushEvents`가 fetch 실패 시 `// Add events back to queue for retry`를 주석 처리. AUTH_ERROR / COMMAND_ERROR 등 보안 감사 이벤트도 같은 큐 → network blip 한 번에 영구 손실. logger.debug 외 alarm 없음. |
| F12 | `register.ts:662, 731`, `execution/index.ts:97` | 가짜 버전 | 🟡 low | bug report / telemetry payload에 `appVersion: '0.2.29'` 하드코딩. 실제 cleanroom `package.json` 버전은 `0.1.0`. cleanroom 사용자 모두가 upstream 버전으로 위장된 telemetry를 발송 → Anthropic 입장에선 통계 오염, 사용자 입장에선 misattribution 노출. |

## F1~F4 + F5~F12 고의 vs 미완성 재판정

| ID | 위치 | 기존 분류 | 재판정 (고의 stub vs LLM 환각 vs 의도된 bait) | 근거 |
|---|---|---|---|---|
| F1 | `register.ts` exec 핸들러 6곳 | 미완성 | **LLM 환각 (실수)** | execution/index.ts엔 `validateCommand` 가드가 있는데 register.ts는 그것을 호출하지 않고 별도 `child_process` import. 두 모듈을 동일 LLM 세션에서 일관 작성 못 한 전형적 환각. 자백 주석 없음 → bait. |
| F2 | `oauth.ts` PKCE/state | 미완성 | **고의 stub** | 151줄에 `// For now, we'll just use the same string (this is not secure!)` 자백. 145줄 `// In a real implementation, this would use crypto functions...` 자백. 학습 stub임을 본인이 명시. |
| F3 | `fileops/index.ts:83` path traversal | 미완성 | **LLM 환각** | 자백 주석 없음. `path.normalize().replace(/^(\.\.(\/|\\|$))+/, '')` 패턴은 OWASP/StackOverflow 게시물에서 흔히 잘못 인용되는 코드와 동일 형태. 학습 데이터 오염 의심. |
| F4 | `claude-code/package.json` author | 메타데이터 미정리 | **메타데이터 미정리** | README는 disclaimer 명시 — 일관성 부족이지 사칭 의도는 아님. |
| F5 | `config/index.ts:114` `require(*.js)` | (신규) | **LLM 환각, RCE 결과** | "config는 JSON이나 JS 둘 다 지원" 패턴은 webpack/eslint 영향. 그러나 `require(절대경로)`를 cwd 영역에 적용하는 건 RCE. 자백 주석 없음. 가장 위험. |
| F6 | `ai/client.ts:123` X-Api-Key | (신규) | **LLM 환각** | Anthropic API는 X-Api-Key (raw key)와 Authorization Bearer (OAuth)를 분리. cleanroom은 둘을 동일 슬롯에 박음 → "OAuth 흐름 작성"과 "API 호출 작성"을 별개 세션에서 만든 흔적. |
| F7 | env-var 이름 drift | (신규) | **LLM 환각** | 같은 의미의 env var이 두 모듈에서 다른 이름. 두 파일을 따로 생성한 LLM 산출물의 전형적 silent inconsistency. |
| F8 | `tokens.ts` in-memory storage | (신규) | **고의 stub** | 주석 명시 자백. 그러나 export interface는 production-ready 모양이라 외형은 bait. |
| F9 | `manager.ts` MAX_SAFE_INTEGER expiresAt | (신규) | **LLM 환각** | "key는 만료 없음 → 그러면 큰 숫자 박자"라는 LLM-스러운 단축. 자백 없음. |
| F10 | `validation.ts:104` isValidPath | (신규) | **LLM 환각** | 정규식이 명백히 잘못. 사용처도 없음 → "validation utility 모듈에는 path validator가 있어야 한다"는 학습 패턴이 비어있는 함수만 만든 사례. |
| F11 | `telemetry/index.ts:432` 주석 retry | (신규) | **LLM 환각 (미완)** | retry 코드를 주석 처리. 작성 중 잊었거나 주석 채우다 종료. |
| F12 | 하드코딩 버전 `0.2.29` | (신규) | **메타데이터 LLM 환각** | upstream 버전을 cleanroom 코드에 그대로 베껴넣은 흔적. |

**관통하는 패턴**: 자백 주석이 있는 F2, F8은 "이건 stub이니 쓰지 마"라는 **솔직한 미완성**.
나머지(F1, F3, F5, F6, F7, F9, F10, F11)는 자백 없이 production-ready처럼 보이는
**LLM 재구성의 silent drift** — paranoid 관점에서 더 위험. 의도적 bait는 아니지만,
"낚는 코드" 우려가 100% 정당하다. 차용 시 코드를 한 줄도 신뢰하면 안 되는 이유.

## 12 audit 항목별 결과

| # | 항목 | 결과 | 발견 |
|---|---|:---:|---|
| 1 | 외부 endpoint 화이트리스트 | ✓ | 위 표 참조. 의심 도메인 0. telemetry endpoint 실재성만 미검증. |
| 2 | 약한 암호 함수 사용 | 🟠 | `Math.random()` 2곳 (F2 oauth, async.ts:169 jitter). `crypto.randomBytes` / `createHash` 등 **호출 0건**. 실제 crypto 모듈을 import한 파일이 없음 → cleanroom은 암호학적으로 0. |
| 3 | input validation → sink | 🟠 | F1(exec), F5(require) 외 fileops의 path traversal(F3) 재확인. 모든 사용자 입력이 sanitizer 없이 sink 도달 가능. |
| 4 | silent fail catch | 🟠 | F11 telemetry retry 주석 drop. AI client (309-355줄) JSON.parse 실패 시 logger.error 후 continue — stream 이벤트 손실 가능. auth/manager.ts:84 token refresh 실패 silent로 INITIAL 복귀 (재인증 강요는 됨, 그러나 사용자에게 보고 부재). |
| 5 | timing attack | ✓ | secret 비교가 코드 내 0건 (token storage가 Map 직접 비교만). 단 향후 실 storage 도입 시 `crypto.timingSafeEqual` 미사용 시 위험. |
| 6 | deserialization 위험 | 🔴 | F5 `require(.js)` 가 RCE. 그 외 JSON.parse는 모두 known-source (config 파일, package.json, AI stream). prototype 오염 패턴 0. |
| 7 | race condition | 🟡 | `auth/manager.ts:202-217` logout이 timer clear 후 storage delete가 await — 짧은 race 가능 (refresh가 동시 진행 중이면 stale token 저장). 실 위험은 낮음. |
| 8 | regex DoS | ✓ | 의심 패턴 0. `(.*)+` / `(.+)+` / nested quantifier 없음. `validation.ts:104` 정규식은 약하지만 ReDoS는 아님. |
| 9 | LLM 환각 신호 | 🟠 | F1, F3, F5, F6, F7, F9, F10, F11 모두 LLM 환각 추정. 별도 절 참조. |
| 10 | bait-like 메타데이터 | 🟡 | F4 (Anthropic 자칭) + F12 (가짜 버전). README disclaimer 있어 사칭 의도 부재 판정. |
| 11 | transitive dependency | ✓ | lock 검토 완료. `@anthropic-ai/claude-code 0.2.29`(공식), `open 10.1.0`, `uuid 11.1.0`, `@types/node`, `@types/uuid`, `default-browser`, `is-docker`, `is-wsl`, `bundle-name`, `run-applescript`, `define-lazy-prop` 모두 정식 sindresorhus / broofa 패키지. integrity SHA512 정합. typosquat 0. |
| 12 | 의심 string literal | ✓ | base64-like, hex 32+, IP 직접 접근, 단축 URL 0건. magic env-var 0. |

## LLM 환각 신호 (구체)

1. **F1 (exec 가드 미연결)**: 같은 repo 안에 `validateCommand` 가드가 있는데도 `register.ts`는 그것을 import하지 않고 `await import('child_process')`로 우회. 두 파일을 다른 컨텍스트에서 생성한 LLM의 cross-module forget.
2. **F5 (.claude-code.js → require)**: "configurable" 외형을 만들기 위해 JS 분기를 추가하면서 `require`의 RCE 영향을 인지 못 함. 표준 LLM 패턴.
3. **F6 (X-Api-Key에 OAuth token)**: AnthropicClient 작성 시 Anthropic 표준 spec을 정확히 못 따라가고 "auth token은 X-Api-Key 헤더"라는 단순화. OAuth 흐름은 별도 파일에 작성하면서 두 흐름의 헤더 차이를 놓침.
4. **F7 (env-var 이름 drift)**: `config/index.ts`와 `telemetry/index.ts`가 다른 세션에서 생성됐다는 강한 신호. 한쪽은 `CLAUDE_TELEMETRY`, 다른 쪽은 `CLAUDE_CODE_TELEMETRY`. 인간 개발자라면 한쪽에서 다른 쪽 import 또는 상수 모듈로 통합.
5. **F9 (MAX_SAFE_INTEGER expiresAt)**: "API key는 만료 없음" → "큰 숫자로 표현" 단축. 인간이라면 `expiresAt: undefined` + `isTokenExpired`에서 분기.
6. **F10 (isValidPath 정규식)**: 함수가 export됐지만 호출부 0. "validation utility는 isValidPath가 있어야 한다"는 LLM 학습 prior가 만든 cargo-cult 함수.
7. **AI 모델 ID**: `claude-3-opus-20240229` 등 cleanroom 기준 시점(2025-03)에 이미 deprecated된 모델 ID만 등장. 학습 데이터 시점(2024) 화석.

## 권고

### 차용 시 절대 그대로 복붙하지 말 것 (블랙리스트)

| 파일 | 라인 | 사유 |
|---|---|---|
| `claude-code/src/config/index.ts` | 81-99, 104-125 | F5 RCE — `.js` config 분기 자체를 제거하고 JSON-only로 |
| `claude-code/src/auth/oauth.ts` | 142-168, 203-227 | F2 PKCE/state stub + setTimeout 가짜 callback |
| `claude-code/src/auth/tokens.ts` | 전체 | F8 in-memory Map. `keytar`/encrypted file로 대체 |
| `claude-code/src/auth/manager.ts` | 236-241 | F9 MAX_SAFE_INTEGER expiresAt |
| `claude-code/src/ai/client.ts` | 120-127 | F6 X-Api-Key 오용. OAuth와 ApiKey를 분리 헤더 |
| `claude-code/src/commands/register.ts` | 794, 866-882, 1144-1176, 1239-1265 | F1 unsanitized exec |
| `claude-code/src/fileops/index.ts` | 83 | F3 path traversal 정규식 |
| `claude-code/src/utils/validation.ts` | 100-119 | F10 약한 path validator |
| `claude-code/src/telemetry/index.ts` | 142 (env name), 110 (endpoint), 430-432 (silent drop) | F7, F11 |

### 매트릭스 §D01/D02 채택 시 우리가 직접 작성해야 할 부분

- **OAuth/PKCE**: cleanroom 보지 말고 RFC 7636 + Node `crypto.randomBytes(32)` + `crypto.createHash('sha256').update(verifier).digest('base64url')` 표준대로
- **token storage**: `keytar`(OS keychain) 또는 OS-specific 암호화 파일. Map 절대 안 됨. 매트릭스 §A의 alpha-memory 패턴 우선
- **command exec dispatcher**: `execFile(cmd, [args])` + 배열 인자 강제. 사용자 문자열 → shell 통째로 전달 금지. 우리 매트릭스 G03 (Slice 2 보안)이 이미 이 결정 가짐
- **path normalization**: `path.resolve` 후 `if (!resolved.startsWith(workspaceRoot + path.sep)) throw` sentinel. F03 fix
- **config loader**: JSON-only. JS/JSON5 절대 X. JSON Schema validation 권장 (zod/ajv)
- **AI client headers**: ApiKey 인증은 `x-api-key` raw, OAuth는 `Authorization: Bearer ...` 분기. 같은 슬롯에 박지 말 것
- **telemetry**: 기본 opt-in, env-var 이름 단일 (`NAIA_TELEMETRY`), endpoint config 가능, retry queue 실 구현 (실패 영구 보관 후 재전송)

### 추가 보호 조치

- **submodule clean 유지** (`projects/refs/ref-cc-cleanroom/`). `npm install` 절대 금지 — 코드 자체는 안전하지만 unnecessary
- **본 보고서를 매트릭스 §B04 F04 옆에 링크** (`refs/cc-cleanroom-deep-audit-2026-04-25.md`). 채택 reviewer가 F5~F12 ID로 위험 라인 확인
- **차용 ticket 템플릿에 강제 체크박스**: "이 PR은 cc-cleanroom의 어떤 파일도 직접 인용하지 않았는가?" Y/N
- **upstream watch (선택)**: ghuntley repo가 update되면 본 audit 재실행. 6개월 주기 충분. 새 commit 없을 시 skip
- **ghuntley tradecraft 확인 실패 기록**: `https://ghuntley.com/tradecraft`은 subscribers-only. 방법론(LLM 종류, prompt, 검증 단계 유무) **공개 정보 없음**. 즉 이 cleanroom이 어떤 LLM·프롬프트로 생성됐는지, 산출물 검증 단계가 있었는지 **외부에서 알 길 없음**. paranoid 관점에서 "검증되지 않은 LLM 산출물"로 취급해야 함 — 본 audit 결론과 일치

## 변경 이력

- 2026-04-25 초안 (이 문서). baseline F1~F4 재판정 + F5~F12 신규 발견 + 차용 블랙리스트 라인 명시.
