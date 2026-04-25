# ref-jikime-adk review — 2026-04-25

**Source**: https://github.com/jikime/jikime-adk (commit b9f4fb98, v1.8.1)

## 1. 무엇인가 / 무엇이 아닌가

jikime-adk는 **Go 기반 CLI 도구**로, Claude Code와 완전히 독립적인 별개 프로젝트입니다. 레거시 현대화(Vue.js, React, Angular → Next.js)에 특화된 **마이그레이션 오케스트레이션 엔진**입니다. naia-adk(워크스페이스 스캐폴드 + 포맷 표준)과는 다른 layer — jikime-adk는 "마이그레이션 자동화" 담당, naia-adk는 "AI 개발 환경 구조화" 담당입니다.

**핵심 차이**: jikime-adk는 자체 바이너리로 동작하며, Claude Code hooks/skills를 통해 integration하는 구조. naia-adk는 포맷과 규약만 정의하고, Claude Code/OpenCode 등이 독립적으로 읽습니다.

## 2. 차용 가능한 패턴 후보

- **듀얼 오케스트레이션** (J.A.R.V.I.S./F.R.I.D.A.Y.): 개발(jarvis) vs 마이그레이션(friday) 두 역할 분리. naia-agent도 이 패턴 고려 가치.
- **CLAUDE.md 기반 규칙 엔진**: 수백 줄의 마크다운에서 agent routing, workflow, 품질 게이트를 정의하는 방식. 우리의 agents-rules.json과 유사하나 마크다운 형태.
- **Hook 시스템**: PreToolUse, PostToolUse, SessionStart 등 내재된 hook으로 안전성/포맷/품질 검사 자동 실행. naia-agent에 이미 .agents/hooks/ 있으나, 세분화도(formatter/linter/ast-grep/lsp) 참고할 수 있음.
- **Agent Teams 실험**: 병렬 multi-agent 오케스트레이션 with file ownership rules. 우리는 subagent 중심인데, 이 모델은 실용적.
- **DDD 방법론** (ANALYZE-PRESERVE-IMPROVE): 동작 보존을 최우선으로 특화된 사이클. 레거시 현대화에 특화되었으나, 기존 코드 리팩토링에도 유용.
- **진행 추적**: `.jikime/specs/SPEC-{ID}/progress.md`처럼 세션 간 상태 persistence. 우리의 progress.json과 개념 동일하나 마크다운 형태.

## 3. 명시적으로 채택 안 할 이유

- **Go 언어**: jikime-adk는 binary/CLI 중심. naia-agent는 메타층(format + rules) 정의만 하므로 언어 의존 없음.
- **레거시 특화**: 마이그레이션 자동화(screenshot-based rebuild, vue→next conversion skill)는 naia-agent의 범위 밖. 필요 시 별도 specialized tool로 이용.
- **Webchat UI**: 내장 web server + React UI는 naia-agent 고민에 포함 안 됨(우리는 Claude Code IDE 중심).
- **87개 Skill**: jikime-adk의 skill은 마이그레이션 task에 최적화. naia-adk skill은 범용 workflow(review, verify, manage)에 중점.
- **4-repo 분리 원칙**: jikime-adk는 단일 binary repo. naia-agent는 workspace format + business extension fork chain으로 설계.

## 4. 이미 우리에 반영된 부분

- **agents-rules.json SoT**: 우리 `.agents/context/agents-rules.json`이 실질적으로 같은 역할(centralized decision logic). 마크다운 vs JSON 형식만 다름.
- **Hook 기반 자동화**: 우리도 PostToolUse에서 review, verify, format 실행하는 구조 유사.
- **Issues-driven workflow**: 14단계 issue-to-commit 프로세스는 jikime-adk의 workflow와 동일한 철학.
- **Progress 파일**: 우리의 `.agents/progress/{issue-slug}.json`이 jikime의 progress.md와 같은 목적.

## 5. R0 채택/거부/이연 권고

- **채택**: Dual Orchestrator 개념(development vs migration) — naia-agent의 두 가지 진행 모드(feature dev vs legacy migration) 명시화에 참고.
- **거부**: jikime-adk 바이너리 의존성 자체는 불필요. 필요 시 plugin으로 loose-coupling.
- **이연**: Agent Teams 병렬 실행 모델 — 현재는 subagent sequential이 안정적. 실전 증명 후 v1.1에서 재평가.
- **이연**: Webchat — naia-agent는 Claude Code IDE 중심이므로 우선순위 낮음.

## 6. 열린 질문

- jikime-adk의 "57개 specialized agents" (readme 상)는 정확히 몇 개인가? agents.md에서 세어보니 26개. 중복 계산 또는 planning 도중 expand 예상.
- DDD (ANALYZE-PRESERVE-IMPROVE) 사이클이 우리의 "점진적 구동+테스트" 갭과 직접 연관 있는지 확인 필요 — 다음 task #4에서.
- F.R.I.D.A.Y. (마이그레이션 오케스트레이션)을 naia-agent에 도입할 실질적 필요성이 있는가? 아니면 specialized tool로 분리?

