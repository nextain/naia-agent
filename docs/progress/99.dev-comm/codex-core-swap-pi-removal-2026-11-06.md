# naia-agent 코어 Pi 제거 및 Codex 기본화 (2026-11-06)

## 1. 결정 및 배경

- **결정**: `naia-agent`의 기본 코어 및 코딩 에이전트(sub-agent·role runner·CLI 기본값)를 **`codex`**로 일원화하고, 기존 **`pi` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) 의존성 및 어댑터·루프·벤치마크·시험 픽스처를 전면 제거**한다.
- **배경**: 대표님 지시(2026-10-31 "당장 naia-agent 에서 pi 걷어내고 codex로 변경 중", 2026-11-06 "naia agent codex교체도 워크트리따서 진행")에 따라 `origin/feat/026-codex-core`(codex exec·app-server 제공자, 승인 관문, 메모리 고침)를 합친 뒤 남아 있던 Pi 기반 경로를 모두 Codex 기반으로 전환하거나 제거한다.
- **참조 문서**: [ARCHITECTURE.md](../../ARCHITECTURE.md), [llm-roles.md](../../llm-roles.md), [requirements.md](../../requirements.md), [user-scenarios.md](../../user-scenarios.md).

## 2. 코어 구조 변화 요약

| 영역 | 기존 (Pi 공존/의존) | 변경 후 (Codex 기본 코어·Pi 제거) |
|---|---|---|
| **대화·AX 코어 공급자** | `codex` (`codex-app-server-provider`), `codex-ax`, `codex-exec` 및 기타 공급자 공존 | `codex` (app-server, 기본 모델 `gpt-5.4`)가 기본 코어; `codex-ax` (trusted broker)·`codex-exec` (단발 JSONL) 지원 |
| **CLI 코딩 기본값 (`naia-agent run` / `cli.json`)** | `coding.agent` 허용 목록에 `pi` 포함, Pi 전용 옵션(`--model`, `--no-tools`, `--pi-bin` 등) 분기 | 기본 에이전트 `codex`; 허용 목록 `["codex", "shell", "opencode", "claude-code", "gemini", "grok"]`, `--no-tools`는 `codex`에서 `--sandbox read-only`(`filesystemAccess: "read_only"`) 강제 및 미지원 에이전트 사전 차단(B1); 구 저장값 `coding.agent="pi"`는 `"codex"`로 자동 이전·안내 및 `config set coding.agent pi` 명시적 거부(R2) |
| **CLI 자가 진단 (`naia-agent doctor`)** | `component: "pi"` (`@earendil-works/pi-coding-agent` 패키지 버전 점검) | `component: "codex"` (`checkCodexPreflight` 기반 Codex CLI 설치·버전 점검) |
| **역할 실행기 (`src/main/adapters/role-runner.ts`)** | `expert`/`main`/`sub`에서 `codex`·`claude-code-cli`·`grok` 외 공급자를 Pi CLI(`makePiSubAgent`)로 폴백 | CLI 워커(`codex`, `claude-code-cli`, `grok`)만 각 CLI 어댑터로 라우팅하고, 계정형 provider(`naia`/`nextain`, `anthropic`)는 Naia/Anthropic 모델 ID가 OpenAI Codex CLI로 넘어가지 않도록 검증된 브리지 지원 전까지 **spawn 전에 분명한 오류(`ok: false`)로 차단**(B2 선택지 (나) 채택). Naia 모델 이름 대소문자 무시 매칭(`hcx-007` → `HCX-007`) 및 실패 리포트 `verification: { ok: false, checks: [{ name: "role", pass: false, details }] }` 복원 |
| **Sub-agent 로스터·위임 스킬·`wireSupervisor`** | `SUPPORTED_SUBAGENTS`·`DELEGATE_AGENTS`·`IssueTeamAgentKind`에 `"pi"` 포함, `wireSupervisor` 기본 `"shell"` | `"pi"` 제거 (`codex`가 1순위 기본 코딩 에이전트, `wireSupervisor` 기본 `subAgentName`도 `"codex"`로 통일 — R9) |
| **패키지 의존성 (`package.json`)** | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` 직접 의존 | 두 패키지 완전 제거 (`package.json`, `pnpm-lock.yaml`) |

## 3. Pi에 기대고 있던 항목 전수 표 및 조치 결과

| 구분 | 파일 / 모듈 | 기존에 Pi에 기대고 있던 내용 | 조치 결과 |
|---|---|---|---|
| **의존성** | `package.json`, `pnpm-lock.yaml` | `@earendil-works/pi-ai` (`0.83.0`), `@earendil-works/pi-coding-agent` (`0.83.0`) 및 `benchmark:pi-loop:*` 스크립트 | 의존성 및 스크립트 완전 제거 |
| **어댑터** | 구 Pi 서브에이전트·게이트웨이·과금 브리지·로컬 provider·비용 증명 어댑터 5종 | Pi CLI (`--mode json -p`) 스폰, Naia/user-owned `models.json` 생성, `@earendil-works/pi-ai` 과금 브리지 및 카탈로그 비용 증명 | 파일 삭제 (`src/main/adapters/subagent-codex.ts`가 기본 코딩 sub-agent 담당, 자식 환경에서 `DISCORD_BOT_TOKEN`·`NAIA_API_KEY`·`ANTHROPIC_API_KEY` 차단 및 `--no-tools`/`read_only` 샌드박스 강제) |
| **어댑터** | `src/main/adapters/role-runner.ts` | LLM 역할(`expert`/`main`/`sub`) 실행기에서 구 Pi 폴백 및 모델 검증 사용 | `role-runner.ts`로 개명, CLI 워커(`codex`, `claude-code-cli`, `grok`) 라우팅 및 비-CLI 계정형 provider(`naia`/`nextain`, `anthropic`) spawn 전 fail-closed 차단(B2 선택지 (나)), 대소문자 무시 Naia 모델 매칭, 실패 시 `verification.ok=false` 리포트 복원 |
| **어댑터** | `src/main/adapters/subagent-roster.ts` | `SUPPORTED_SUBAGENTS`·`DECLARED_SUBAGENTS`에 `"pi"` 등록 | `"pi"` 제거, `["codex", "opencode", "shell", "claude-code", "gemini", "grok"]` 유지 |
| **어댑터** | `src/main/adapters/delegate-agent-skill.ts` | `DELEGATE_AGENTS` 목록 첫 항목으로 `"pi"` 노출 | `"pi"` 제거 (`"codex"`가 첫 항목) |
| **어댑터** | `src/main/adapters/subagent-issue-actors.ts` | `session_end` 이벤트에서 구 Pi 추정 비용 필드 추출 | 일반 `estimatedCostUsd` 추출로 전환 |
| **어댑터** | `src/main/adapters/sqlite-paid-call-budget.ts` | 예산 원장 `costSource` 리터럴 | `"catalog"`로 일반화 |
| **어댑터** | `src/main/adapters/naia-settings-store.ts` | 주석 내 Pi 참조 | Codex 기준으로 정리 |
| **앱** | `src/main/app/cli-supervise.ts` | `--agent` 도움말에 `pi` 표기, `renderEvent`/`renderReport` 출력 | 기본 에이전트 `codex` 지정, `--no-tools`는 `codex` 전용 읽기 전용(`--sandbox read-only`)으로 강제하고 타 에이전트는 인자 오류(exit 64)로 차단 |
| **앱** | `src/main/app/cli-manage.ts` | `coding.agent` 허용 목록에 `"pi"` 포함, `models` 폴백 설명에 Pi 표기 | `coding.agent` 허용 목록에서 `"pi"` 제거, 구 저장값 `"pi"` 자동 `"codex"` 이전 및 `config set coding.agent pi` 수정 안내 오류 반환 |
| **앱** | `src/main/app/cli-chat.ts` | `PROVIDER_DEFAULT_MODEL`에 `codex`/`codex-ax`/`codex-exec` 기본 모델(`gpt-5.4`) 명시 보강 | `codex` 계열 기본 모델(`gpt-5.4`) 명시 및 기본 코어 연결 |
| **도메인** | `src/main/domain/issue-team.ts` | `IssueTeamAgentKind = "pi" \| "codex" \| "opencode"` | `"codex" \| "opencode"`로 축소 (`"pi"` 제거) |
| **도메인** | `src/main/domain/orchestration.ts`, `src/main/domain/issue-orchestration.ts` | 구 Pi 추정 비용 필드 및 타입 | 일반 `estimatedCostUsd` / `"catalog"` 필드로 교체 |
| **컴포지션** | `src/main/composition/index.ts`, `mixed-issue-team-agents.ts`, `issue-team-role-executor.ts` | 구 Pi 분기 및 `wireSupervisor` 기본 `"shell"` | `"pi"` 분기 제거 (`codex`·`opencode` 사용) 및 `wireSupervisor` 기본 `subAgentName: "codex"` 통일 |
| **컴포지션/벤치마크** | 구 Pi 연속 루프·비용 비교기·전용 스크립트·벤치마크 | Pi 전용 연속 루프 오케스트레이터 및 비용 비교기 | Pi 전용 파일 삭제 (`benchmark/run-issue-team-deterministic.mjs`, `benchmark/run-multi-issue-deterministic.mjs`, `benchmark/run-single-issue-live.mjs`는 Codex 기준으로 유지 및 산출물 재생성) |
| **CLI 진입점** | `bin/naia-agent.mjs`, `bin/naia-agent-run.mjs`, `bin/naia-agent-manage.mjs`, `bin/naia-agent-runtime.mjs` | `pi` 서브에이전트 분기, `doctor`의 `@earendil-works/pi-coding-agent` 점검, 구 루프 바이너리 | `codex` 기본 분기·`--no-tools` 전달·구 `coding.agent="pi"` 자동 이전 안내·`doctor` Codex 점검으로 교체, 구 루프 바이너리 삭제 |
| **빌드 진입점** | `scripts/builds/agent-stdio-entry.mjs` | 역할 실행기 임포트 및 배선 | `role-runner.ts`(`makeRoleProcessingPlans`, `makeRoleSupervisorRunner`)로 교체 |
| **시험** | `src/test/role-runner.contract.test.ts`, `src/test/uc-cli-subagent-codex.contract.test.ts`, `src/test/cli-manage.contract.test.ts` 외 | 구 Pi 전용 시험 12개 삭제 및 Codex 계약 시험 이관 | Pi 전용 시험 12개 삭제, 자식 프로세스 환경 격리(`DISCORD_BOT_TOKEN`·`NAIA_API_KEY`·`ANTHROPIC_API_KEY` 차단)·읽기 전용 실행(`--sandbox read-only`)·정직한 실패·역할 라우팅 fail-closed·`coding.agent="pi"` 마이그레이션 계약을 Codex 시험으로 이관 |

## 4. B2 역할 라우팅 선택지 결정 및 근거 (2회차 검수 반영)

- **선택한 길**: **(나) 지원 전까지 spawn 전에 분명한 오류로 막는다.**
- **까닭**:
  1. `subagent-codex.ts`의 자식 환경 격리 계약(B3)은 `NAIA_API_KEY`, `NAIA_ANYLLM_API_KEY`, `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`을 자식 프로세스 환경에서 원천 차단(`BLOCKED_WORKER_ENV_KEYS`)하므로, Codex CLI 자식에 계정 열쇠를 노출하지 않는 보안 경계와 일치한다.
  2. Codex CLI(`codex exec --json`)의 JSONL 스트림 프로토콜은 백엔드가 실제로 사용한 `provider` 및 `responseModel`을 독립적으로 보고하지 않으며(`modelEvidenceSource: "adapter_requested"`), `anthropic`은 OpenAI 호환 Naia 게이트웨이 공급자도 아니므로, 선택지 (가)의 전제 조건("요청한 provider/model과 실제가 다르면 실패하게 한다")을 거짓 주장 없이 보장할 수 없다.
  3. 따라서 CLI 워커(`codex`, `claude-code-cli`, `grok`)만 각자의 인증된 CLI 어댑터로 실행하고, `naia`/`nextain`/`anthropic` 역할은 검증된 브리지 지원 전까지 **spawn 전에 분명한 오류(`ok: false`)와 실패 검증 리포트(`verification: { ok: false, checks: [{ name: "role", pass: false, details }] }`)로 차단**하는 것이 가장 정직하고 안전하다.
