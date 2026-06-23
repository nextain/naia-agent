# UC-CLI — naia-agent 단독 CLI 오케스트레이션 (권위 계약서, P01)

> 상태: **DRAFT (P01)** — 2026-06-22. clean-rebuild 컷오버가 누락한 단독 CLI/오케스트레이션
> 역량의 신 헥사고날 arch 편입 계약. 근본 원인 = 구 단독 구현에 UC가 없어 UC-주도 재작성
> 스코프에서 빠짐(상세: `.agents/progress/naia-agent-cutover-gap-and-capability-port-2026-06-22.md`).
> 원본 보존: `backup/main-2026-06-22`(acf88e0) · 구 권위 = `docs/vision-statement.md`(R4) + `bin/naia-agent.ts`(CLI).

## 배경 — 왜 이 UC인가 (사용자 directive 2026-06-22)

원래 2단계 목표: ① naia-agent **단독 CLI** 오케스트레이션을 제대로 구현 → ② naia-os 워크스페이스에 배선 연결.
naia-os 워크스페이스 작업이 아직 안 됐으므로 **①(단독 CLI)을 먼저** 한다는 것이 이전 naia-agent의 작업
범위였다. ①은 구 모노레포에서 완료(Slice 3-XR-A~O)됐으나 clean-rebuild가 UC-주도로 재스코프하며 ②
전에 ①의 코드가 빠졌다. 본 UC는 **①을 신 arch UC로 정식 편입**해 trajectory를 잇는다(②=후속 phase).

## 액터 / 트리거

사용자(luke)가 **naia-os 없이** 터미널에서 단독으로 `naia-agent`를 실행해 실제 작업을 시킨다.
naia-agent는 LLM 텍스트 턴 엔진이자 **sub-agent supervisor**(타 AI 오케스트레이터)다.

> **구현 상태(2026-06-23)**: **S2 Supervisor mode = 출시**(`bin/naia-agent-run.mjs` + `app/cli-supervise.ts`, SPEC-011). S3 인터럽트는 S2 한정 부분(2회차 Ctrl+C 강제). **S1 Direct mode·S4(`--repl`/`--skills-dir`/`--memory`/`--service`) = 미구현 후속 슬라이스**(엔진 `chat-turn-handler` 는 존재, CLI 표면만 defer). 아래 S1·S4 는 *목표 계약*이지 현 shipped 아님.

## 시나리오 (사용자 가치)

- **S1 Direct mode**: `naia-agent "X 함수 추가해"` → in-process 에이전트가 tool-loop(ReAct, 멀티홉)로
  실제 작업 수행(bash/file/skill), 응답 스트리밍. (구 `runDirect`)
- **S2 Supervisor mode**: naia-agent가 외부 코딩 에이전트(pi/opencode/claude-code/codex/gemini)를
  **sub-agent로 spawn** → 이벤트 스트림 통합 + workspace 변경 감시 + 완료 시 검증(test/lint/build) +
  **정직한 숫자 리포트**(filesChanged/additions/deletions/verification). (구 `Phase1Supervisor`)
- **S3 Interrupt**: 실시간 중단("stop"/Ctrl+C) → 진행 중 sub-agent 안전 종료(SIGTERM→유예→SIGKILL),
  terminal 이벤트 1회 + 부분 리포트. (구 `InterruptManager`)
- **S4 보조**: `--repl`(다중 턴), `--skills-dir`(naia-adk 스킬), `--memory`(naia-memory), `--workdir`,
  `--service`(매니페스트), exit code 0/2/3.

## 경계 원칙 (구 CLAUDE.md 계승 — 2조건 모두 YES여야 naia-agent 소속)

1. CLI로 **단독 실행 시 의미** 있는가?  2. **LLM이 관리·호출**하는가(또는 LLM 루프에 직접 필요)?
naia-os 전용 인프라(HTTP/WebRTC/오디오) 내장 금지. naia-omni 내부 구현 노출 금지. "나중에 주입" 하드코딩 금지.

## 헥사고날 이식 계약 (직교 — codex 크로스리뷰 #2)

포트는 **semantic 계약**이어야 한다. domain/app은 "세션 이벤트·워크스페이스 변경 요약·검증 리포트·
취소 요청"만 본다 — PID/SIGTERM/stdout chunk/exit code/git diff 포맷/runner 이름 등 **메커니즘은
adapter 안에만**. import-boundary 게이트(`src/test/import-boundary.contract.test.ts`)가 강제.

| 신 포트(제안) | 책임(semantic) | adapter(메커니즘) |
|---|---|---|
| `SubAgentPort` | spawn(taskSpec)→세션 이벤트 스트림(planning/tool_use/text/session_end), cancel(reason) | adapter-pi / adapter-opencode-cli (subprocess·NDJSON·SIGKILL) |
| `WorkspacePort` | 변경 요약 스트림(added/modified/deleted + 수치) | chokidar-watcher + git-diff |
| `VerifierPort` | 검증 리포트(pass/실패 수치, never-throws) | test/lint/build/typecheck/shell runner |
| `SupervisorApp`(app) | sub-agent 스트림 ⊕ workspace 스트림 merge → session_end 시 verify → 정직 리포트 | (없음 — 순수 조립) |

## 수용 기준 (P04 계약테스트로 고정 — codex #4)

- **AC1 인터럽트 에스컬레이션**: cancel → SIGTERM, 유예(500ms) 관측, hard-kill, terminal 이벤트/리포트 **정확히 1회**.
- **AC2 verifier-never-throws**: 실패/타임아웃/도구부재/malformed 출력 → 구조화 수치 실패 리포트(throw 없음).
- **AC3 stream-merge 순서**: sub-agent·workspace 이벤트 인과/세션 순서 보존, terminal 드롭 0.
- **AC4 session_end 검증**: 실패/중단 세션 포함 항상 verify 수행.
- **AC5 직교/경계**: domain/app이 subprocess/git/transport 미import(import-boundary green), fake 포트로 supervisor 결정론 검증.
- **AC6 roster 선택**: pi/opencode/claude-code/codex/gemini 어댑터 선택이 명시 + 미설치 시 정직 unsupported.

## 단계 (codex 순서보정 — 최소 경로 먼저)

- **2a**: `SubAgentPort`(semantic) + `adapter-shell`(계약 레퍼런스) + `Phase1Supervisor`(app, 단일 sub-agent + 검증 stub) + AC1·AC3·AC5 계약테스트. = 최소 오케스트레이션 골격.
- **2b**: `adapter-pi` + `adapter-opencode-cli` (실 sub-agent) + AC1·AC6.
- **2c**: `WorkspacePort`/`VerifierPort` 실 어댑터 + AC2·AC4 → 정직보고 완성.
- **(후속)** naia-os gRPC 배선 = 원래 목표 ②(별도 UC, naia-os 워크스페이스 작업 후).

## 비범위 (이 UC 아님)

벤치마크 실측(Stage 1b, supervisor 의존), opencode-acp 승인게이트(MAYBE), ActiveBrain, naia-os 연동(②).

## 참조

구 `docs/vision-statement.md`(R4 motivation 1~6), 구 `docs/architecture-hybrid.md`(7원칙·인터럽트 §6c),
구 `docs/adapter-contract.md`(SubAgentAdapter 계약), 구 `packages/{adapter-pi,adapter-opencode-cli,cli-app,workspace,verification}`.
