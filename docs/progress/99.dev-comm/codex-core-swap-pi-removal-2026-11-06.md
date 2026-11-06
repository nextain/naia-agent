# naia-agent 코어 Pi 제거 및 Codex 기본화 (2026-11-06)

## 1. 결정 및 배경

- **결정**: `naia-agent`의 기본 코어 및 코딩 에이전트(sub-agent·role runner·CLI 기본값)를 **`codex`**로 일원화하고, 기존 **`pi` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) 의존성 및 어댑터·루프·벤치마크·시험 픽스처를 전면 제거**한다.
- **배경**: 대표님 지시(2026-10-31 "당장 naia-agent 에서 pi 걷어내고 codex로 변경 중", 2026-11-06 "naia agent codex교체도 워크트리따서 진행")에 따라 `origin/feat/026-codex-core`(codex exec·app-server 제공자, 승인 관문, 메모리 고침)를 합친 뒤 남아 있던 Pi 기반 경로를 모두 Codex 기반으로 전환하거나 제거한다.
- **참조 문서**: [ARCHITECTURE.md](../../ARCHITECTURE.md), [llm-roles.md](../../llm-roles.md), [requirements.md](../../requirements.md), [user-scenarios.md](../../user-scenarios.md).

## 2. 코어 구조 변화 요약

| 영역 | 기존 (Pi 공존/의존) | 변경 후 (Codex 기본 코어·Pi 제거) |
|---|---|---|
| **대화·AX 코어 공급자** | `codex` (`codex-app-server-provider`), `codex-ax`, `codex-exec` 및 기타 공급자 공존 | `codex` (app-server, 기본 모델 `gpt-5.4`)가 기본 코어; `codex-ax` (trusted broker)·`codex-exec` (단발 JSONL) 지원 |
| **CLI 코딩 기본값 (`naia-agent run` / `cli.json`)** | `coding.agent` 허용 목록에 `pi` 포함, Pi 전용 옵션(`--model`, `--no-tools`, `--pi-bin` 등) 분기 | 기본 에이전트 `codex`; 허용 목록 `["codex", "shell", "opencode", "claude-code", "gemini", "grok"]`, Pi 분기 제거 |
| **CLI 자가 진단 (`naia-agent doctor`)** | `component: "pi"` (`@earendil-works/pi-coding-agent` 패키지 버전 점검) | `component: "codex"` (`checkCodexPreflight` 기반 Codex CLI 설치·버전 점검) |
| **역할 실행기 (`role-runner`)** | `expert`/`main`/`sub`에서 `codex`·`claude-code-cli`·`grok` 외 공급자를 Pi CLI(`makePiSubAgent`)로 폴백 | `codex` (`makeCodexSubAgent`)를 기본 코어로 라우팅하고 `claude-code-cli` (`makeClaudeCodeSubAgent`)·`grok` (`makeGrokSubAgent`)을 직접 연결, Pi 폴백 제거 |
| **Sub-agent 로스터 및 위임 스킬** | `SUPPORTED_SUBAGENTS`·`DELEGATE_AGENTS`·`IssueTeamAgentKind`에 `"pi"` 포함 | `"pi"` 제거 (`codex`가 1순위 기본 코딩 에이전트) |
| **패키지 의존성 (`package.json`)** | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` 직접 의존 | 두 패키지 완전 제거 (`package.json`, `pnpm-lock.yaml`) |

## 3. Pi에 기대고 있던 항목 전수 표 및 조치 결과

| 구분 | 파일 / 모듈 | 기존에 Pi에 기대고 있던 내용 | 조치 결과 |
|---|---|---|---|
| **의존성** | `package.json`, `pnpm-lock.yaml` | `@earendil-works/pi-ai` (`0.83.0`), `@earendil-works/pi-coding-agent` (`0.83.0`) 및 `benchmark:pi-loop:*` 스크립트 | 의존성 및 스크립트 완전 제거 |
| **어댑터** | `src/main/adapters/subagent-pi.ts` | Pi CLI (`--mode json -p`) 자식 프로세스 스폰 및 JSONL 파싱 어댑터 (`makePiSubAgent`) | 파일 삭제 (`subagent-codex.ts`가 기본 코딩 sub-agent 담당) |
| **어댑터** | `src/main/adapters/naia-pi-provider.ts` | Naia 게이트웨이용 Pi `models.json` 생성 및 Pi 전용 모델 능력 판정 | 파일 삭제 |
| **어댑터** | `src/main/adapters/naia-pi-versioned-billing.ts` | `@earendil-works/pi-ai` 스트림 래핑 기반 게이트웨이 과금 브리지 | 파일 삭제 |
| **어댑터** | `src/main/adapters/user-owned-pi-provider.ts` | 사용자 소유 자격증명용 로컬 루프백 프록시 + Pi `models.json` 생성기 | 파일 삭제 |
| **어댑터** | `src/main/adapters/pi-cost-attestation.ts` | Pi 모델 카탈로그(`@earendil-works/pi-ai/models.generated.js`) 기반 비용 증명기 | 파일 삭제 |
| **어댑터** | `src/main/adapters/pi-role-runner.ts` | LLM 역할(`expert`/`main`/`sub`) 실행기에서 `makePiSubAgent` 폴백 및 Pi 모델 검증 사용 | Codex 기본 라우팅(`makeCodexSubAgent` + `makeClaudeCodeSubAgent` + `makeGrokSubAgent`)으로 교체 |
| **어댑터** | `src/main/adapters/subagent-roster.ts` | `SUPPORTED_SUBAGENTS`·`DECLARED_SUBAGENTS`에 `"pi"` 등록 및 `makePiSubAgent` 연결 | `"pi"` 제거, `["codex", "opencode", "shell", "claude-code", "gemini", "grok"]` 유지 |
| **어댑터** | `src/main/adapters/delegate-agent-skill.ts` | `DELEGATE_AGENTS` 목록 첫 항목으로 `"pi"` 노출 | `"pi"` 제거 (`"codex"`가 첫 항목) |
| **어댑터** | `src/main/adapters/subagent-issue-actors.ts` | `session_end` 이벤트에서 `piEstimatedCost` 추출 | 일반 `estimatedCost` / `costUsd` 추출로 전환 |
| **어댑터** | `src/main/adapters/sqlite-paid-call-budget.ts` | 예산 원장 `costSource: "pi_catalog"` 리터럴 | `"catalog"`로 일반화 |
| **어댑터** | `src/main/adapters/naia-settings-store.ts` | 주석 내 Pi 참조 | Codex 기준으로 정리 |
| **앱** | `src/main/app/cli-supervise.ts` | `--agent` 도움말에 `pi` 표기, `renderEvent`/`renderReport`에서 `Pi 모델`·`piEstimatedCost` 출력 | 기본 에이전트 `codex` 지정, `Codex/에이전트 모델` 및 `estimatedCost` 출력으로 전환 |
| **앱** | `src/main/app/cli-manage.ts` | `coding.agent` 허용 목록에 `"pi"` 포함, `models` 폴백 설명에 Pi 표기 | `coding.agent` 허용 목록에서 `"pi"` 제거(`"codex"` 포함), 설명 정리 |
| **앱** | `src/main/app/cli-chat.ts` | `PROVIDER_DEFAULT_MODEL`에 `codex`/`codex-ax`/`codex-exec` 기본 모델(`gpt-5.4`) 명시 보강 | `codex` 계열 기본 모델(`gpt-5.4`) 명시 및 기본 코어 연결 |
| **도메인** | `src/main/domain/issue-team.ts` | `IssueTeamAgentKind = "pi" \| "codex" \| "opencode"` | `"codex" \| "opencode"`로 축소 (`"pi"` 제거) |
| **도메인** | `src/main/domain/orchestration.ts`, `src/main/domain/issue-orchestration.ts` | `piEstimatedCost`, `"pi_catalog"` 필드 및 타입 | 일반 비용 필드로 교체 또는 제거 |
| **컴포지션** | `src/main/composition/mixed-issue-team-agents.ts` | `makePiSubAgent` 임포트 및 `agent === "pi"` 분기 | `"pi"` 분기 및 임포트 제거 (`codex`·`opencode` 사용) |
| **컴포지션** | `src/main/composition/issue-team-role-executor.ts` | `piEstimatedCost` 참조 | 일반 비용 필드로 정리 |
| **컴포지션** | `src/main/composition/pi-continuous-loop.ts`, `pi-continuous-loop-control.ts` | Pi 전용 연속 루프 오케스트레이터 | 파일 삭제 |
| **벤치마크** | `src/main/benchmark/pi-cost-comparison.ts`, `benchmark/*`, `scripts/pi/*`, `examples/*pi*` | Pi 전용 비용 비교·연속 루프 벤치마크 및 헬퍼 스크립트 | 파일 삭제 |
| **CLI 진입점** | `bin/naia-agent.mjs`, `bin/naia-agent-run.mjs`, `bin/naia-agent-manage.mjs`, `bin/naia-agent-runtime.mjs`, `bin/naia-agent-loop.mjs` | `pi` 서브에이전트 분기, `doctor`의 `@earendil-works/pi-coding-agent` 점검, `naia-agent-loop.mjs` | `codex` 기본 분기·`doctor` Codex 점검으로 교체, `bin/naia-agent-loop.mjs` 삭제 |
| **빌드 진입점** | `scripts/builds/agent-stdio-entry.mjs` | `pi-role-runner` 주석 및 배선 | Codex 기반 역할 실행기 배선 유지 및 Pi 참조 제거 |
| **시험** | `src/test/uc-naia-pi-controlled.integration.test.ts` 외 Pi 전용 시험 14개 | controlled Pi fixture 및 Pi 전용 단위·계약·통합 시험 | Pi 전용 시험 삭제, 공용 CLI·역할·로스터·위임·예산·오케스트레이션 시험은 `codex` 기준으로 전환 |
