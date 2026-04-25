# Log Policy — naia-agent

**작성일**: 2026-04-25 (Slice 2.7)
**Scope**: naia-agent CLI + embedded host + multi-tool harness 호환
**Status**: stable — additive only

본 문서는 로깅의 정규 표준. 도구 무관(opencode/Codex/Gemini/naia 자체 모두 동일).

---

## 1. 레벨 (LogLevel)

| Level | 용도 | 예시 |
|---|---|---|
| **debug** | 개발 디버깅 (production 미권장) | LLM request body, internal state dumps |
| **info** | 핵심 상태 transition | `session.started`, `turn.ended`, `tool.started/ended`, `compaction` |
| **warn** | 비정상 동작 (정상 흐름이지만 주의) | `DANGEROUS BLOCKED`, fixture fallback, SDK schema drift |
| **error** | 작업 실패 (recoverable) | tool execution error, API timeout, parse error |
| **fatal** | 프로세스 종료 직전 (unrecoverable) | catastrophic failure, OOM, unrecoverable session state |

### 1.1 Default level
- **bin/naia-agent.ts**: `warn` (사용자 노이즈 최소)
- **examples/**: `info` (개발 시연)
- **production host**: 사용자 명시 (기본 `info`)
- **CI smoke**: `error` (PASS/FAIL만 보이게)

---

## 2. 출력 위치

### 2.1 기본
- **stderr**: 모든 로그 (stdout은 사용자 답변·tool result 전용)
- 이유: pipe 시 (`pnpm naia-agent ... | grep`) 답변만 통과

### 2.2 옵션
- **`--log-file <path>`**: 파일에 추가 출력 (stderr와 병행)
- **`LOG_FILE` env**: 동일
- **`LOG_DEST=file-only`**: stderr 끄고 file만
- **`LOG_DEST=both`**: stderr + file (default when --log-file)

### 2.3 파일 위치 권장
```
~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl
```
또는 프로젝트 root `.naia-agent/logs/`. 둘 다 `.gitignore` 포함.

---

## 3. 회전 (rotation)

- **Daily**: 파일명에 YYYYMMDD 포함, 매일 신규 파일
- **Size cap**: 10 MB per file (초과 시 `.1`, `.2` rotated)
- **Retention**: 30일 (default)
- 구현: 이번 단계 미포함 (opt-in script로 추후)

---

## 4. 포맷 (JSON-lines)

```json
{"ts":"2026-04-25T14:30:00.123Z","level":"info","msg":"tool.started","sessionId":"sess-x","tool":"bash","tags":["agent"]}
```

### 4.1 필수 필드
| 필드 | 타입 | 의미 |
|---|---|---|
| `ts` | ISO 8601 | 타임스탬프 (UTC) |
| `level` | string | LogLevel |
| `msg` | string | event name 또는 메시지 |

### 4.2 선택 필드 (권장)
| 필드 | 의미 |
|---|---|
| `sessionId` | Agent.session.id |
| `tags[]` | Logger.tag()로 누적된 태그 |
| `elapsedMs` | Logger.time() 측정값 |
| `err.{name,message,stack}` | Error 객체 정보 |
| `tool` | tool 호출 시 이름 |
| custom ctx | 자유 (key collision 주의) |

---

## 5. 민감 정보 마스킹 (필수)

### 5.1 자동 redact 패턴
| 패턴 | 마스킹 |
|---|---|
| `sk-ant-...` (Anthropic) | `sk-ant-***` |
| `sk-...` (OpenAI/generic) | `sk-***` |
| `gw-...` (gateway keys) | `gw-***` |
| `AIzaSy...` (Google) | `AIzaSy***` |
| `Bearer ` 헤더 값 | `Bearer ***` |
| `Authorization` 헤더 | 키 이름만 보존, 값 redact |
| 12+ chars hex (uuid/hash 제외 패턴) | 사람 검토 필요 시만 |

### 5.2 OK to log (마스킹 대상 아님)
- 사용자 prompt content (사용자 본인 발화)
- LLM 응답 content (사용자에게 보일 답변)
- tool name, exit code, file path (workspace 내)
- session id, request id

### 5.3 절대 금지
- API key 값 inline
- OAuth token 값
- 사용자 비밀번호, PII (개인정보)
- 환경변수 dump (전체 process.env)

### 5.4 구현
`packages/observability/src/redact.ts` — `redactSecrets(text)` 함수. ConsoleLogger 내부 자동 적용.

---

## 6. 이벤트별 정규 fields

### 6.1 Session lifecycle
- `session.started`: `sessionId`, `model`, `provider`, `systemPromptLen`
- `session.active`: `sessionId`
- `session.closed`: `sessionId`, `state`, `turnCount`

### 6.2 Turn
- `turn.started`: `sessionId`, `userTextLen`, `recalled` (memory hits)
- `turn.ended`: `sessionId`, `assistantTextLen`, `toolCallsCount`

### 6.3 LLM
- `llm.request`: `model`, `messageCount`, `toolsCount`
- `llm.response`: `model`, `stopReason`, `usage.{input,output}Tokens`
- `llm.error`: `model`, `err.message`, `retryAttempt`

### 6.4 Tool
- `tool.started`: `tool.name`, `tool.tier`, `tool.inputSize` (size only, not value)
- `tool.ended`: `tool.name`, `result.length`, `success`, `elapsedMs`
- `tool.error.halt`: `consecutiveErrors`, `errorCode`, `severity`, `retryable`

### 6.5 Compaction
- `compaction`: `droppedCount`, `realtime`, `tokensBefore`, `tokensAfter`

### 6.6 Security
- `security.dangerous_blocked`: `pattern.reason`, `commandPrefix` (60 chars max)
- `security.path_escape`: `attempted` (relative), `workspaceRoot` (path only)

---

## 7. CLI 플래그

| 플래그 | env | default |
|---|---|---|
| `--log-level <level>` | `LOG_LEVEL` | bin: `warn` / examples: `info` |
| `--log-file <path>` | `LOG_FILE` | (none — stderr only) |
| `--log-dest <stderr\|file-only\|both>` | `LOG_DEST` | `both` (when --log-file) / `stderr` |

### 7.1 예시
```bash
# 기본 (stderr, warn)
pnpm naia-agent "hi"

# debug + 파일 저장
pnpm naia-agent --log-level debug --log-file ~/.naia-agent/logs/today.jsonl "hi"

# CI: error만 stderr
LOG_LEVEL=error pnpm naia-agent "..."
```

---

## 8. Multi-tool harness 호환

본 정책은 도구 무관:
- **Claude Code**: stderr가 transcript에 포함됨 → 사용자가 보는 로그는 우리 정책에 따름
- **opencode / Codex**: 동일
- **Gemini CLI**: 동일
- **naia 자체**: 본 정책 따름

도구별 추가 로깅 (예: Claude Code transcript)은 host 책임. 우리는 stderr 표준만 보장.

---

## 9. 외부 sink (defer)

- **OpenTelemetry / Jaeger / Datadog**: 자체 매트릭스 §B12 (Sentry-style telemetry 거부) — 우리 Logger/Tracer/Meter contract만 사용. 외부 sink는 host가 직접 어댑터 작성
- **stdout JSON streaming**: pipe로 외부 도구 (jq 등) 처리 가능 — 단 기본은 stderr이라 영향 없음

---

## 10. 매트릭스 cross-link

- **A26** Logger.tag/time (Slice 2 — opencode 영향)
- **A27** Observability 단위 테스트 (Slice 2)
- **A31** 신규 — 로그 정책 정규화 + redact (Slice 2.7)
- **B12** Sentry-style telemetry 거부 (자체 contract 우선)
- **F09** cleanroom 단독 의존 금지 (redact 패턴 OWASP 출처)

---

## 11. 변경 이력

- **2026-04-25** (Slice 2.7): 초기 정책. 5 levels + JSON-lines + redact + CLI 플래그
