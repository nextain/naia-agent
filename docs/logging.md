# 로깅 규약 (Logging Convention) — naia-agent

루크 지시(2026-06-12)로 확립한 프로젝트 로깅 원칙. 신규 코드와 **이식(transplant)하는 코드 모두**에 적용.

## 원칙 1 — 진입·분기 로깅 (debug 모드 전용)

신규/이식 코드는 다음 지점에서 **반드시 로그**를 남긴다. **디버그 모드에서만 출력**(릴리즈에선 생략/ no-op 가능):

- **객체/함수 진입** (constructor, 주요 메서드·핸들러 진입)
- **로직 분기 및 분기 진입** (라우팅, if/switch 의 각 경로 진입 등)

각 로그에 **반드시 포함**: ① 시간(timestamp) ② 클래스/컴포넌트명 ③ 파라미터들(값; 단 **비밀/키는 이름만**).

agent 측 메커니즘:
- 코어(brain): `DiagnosticLog` 포트(`diag.log(message, ctx)`) — ctx 에 파라미터 객체. 디버그 게이트는 주입 측(entry)에서.
- entry/adapter: `[naia-agent]` prefix `process.stderr`.
- 디버그 모드 플래그: `NAIA_AGENT_DEBUG=1`(미설정=릴리즈, 진입·분기 로그 생략).

## 원칙 2 — logs-first 디버깅 (1순위, HARD RULE)

**문제를 잡을 때·디버깅·원인규명 시 반드시 로그부터 확인하는 것이 1순위.** 추측·이론·도구 제작보다 로그가 먼저다.
- "왜 느리지/실패하지?" → 추측 금지. 관련 로그를 열어 타임스탬프/라인으로 근거를 댄다.
- 크기·동작·원인을 단정하기 전 `du`/`ls`/로그로 실측한 수치를 댄다.
- (계기: provider-provenance e2e-tauri 90초 행을 로그 안 보고 몇 시간 추측한 실패.)

## 로그 표면 (디버깅 시 먼저 볼 곳)

| 증상 | 먼저 볼 로그 (naia 로그 디렉터리 `.naia/logs/`) |
|------|-------------|
| agent 처리·provider 해석·대화 흐름 | `agent-stderr.log` |
| LLM 호출/응답 | `llm-debug.log` |
| 기동/배선(config·skills·memory) | `agent-stderr.log` 의 `stdio ready (...)` 라인 |

## 코드 규약 (forward-only — 기존 이식분 일괄 리팩터 안 함, 이식 부담 회피)

1. **stdout 은 wire(AgentMessage) 전용.** 진단/로그는 **stderr** 로만(stdout 로그는 protocol 파싱 깨짐).
2. `console.log` 직접 금지. 표준 경로(`DiagnosticLog`/prefix stderr) 사용.
3. 비밀 값 로그 금지 — 이름만. **자동 방어선**: `DiagnosticLog` sink(`adapters/diagnostic.ts`)가 write 직전 `redactSecrets`(`adapters/redact.ts`)로 알려진 키·토큰(sk-/AIza/ghp_/xox/AKIA/gw-/JWT)을 `[REDACTED]` 마스킹한다 — 실수로 message/ctx 에 섞여도 stderr 누출 차단(보수적: 명백한 키 형태만, 오탐 최소).
4. 만지는(신규·이식) 파일에만 원칙 1 적용. 기존 코드 일괄 교체 X.

cf 루트 메모리 `feedback_observe_before_build_logs_first`, 셸/Rust 측은 [naia-os](https://github.com/nextain/naia-os) `docs/logging.md`.
