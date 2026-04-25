# CLAUDE.md — naia-agent

본 파일은 Claude Code(또는 이를 사용하는 에이전트) 전용 추가 규칙. 일반 entry는 `AGENTS.md` 참조.

## 필수 읽기 순서 (코드 만지기 전)

1. `AGENTS.md` (이 디렉터리) — 진입점 + 작업 규칙
2. `.agents/progress/design-recheck-2026-04-25.md` — 현 R0 상태
3. `.agents/progress/ref-adoption-matrix.md` — 채택 매트릭스
4. `.agents/progress/runnable-testable-gap.md` — 갭

위 4개를 읽지 않은 상태에서 `packages/` 하위 코드 수정 금지.

## Claude 전용 추가 금지 행위

### G1. 스켈레톤 미존재 시 코드 변경 차단

`bin/naia-agent` 진입점이 존재하지 않는 한, 다음 행위 금지:

- `packages/core/src/agent.ts` 수정
- `packages/runtime/src/` 신규 파일 추가 (테스트 제외)
- `examples/` 외 위치에 새 host 코드 작성

해소 시점: sub-issue #3 (G01 bin/naia-agent) close 후 자동 해제.

### G2. PAUSED 브랜치 보호

`migration/phase-d` 브랜치 절대 push/merge 금지. 본 브랜치는 Phase B + C.2 (189 unit test) 보존용. 재개는 사용자 명시 directive 후.

### G3. ref 코드 수정 금지

`projects/refs/ref-*` 하위는 read-only reference. **절대 수정 금지** (submodule clean 유지).

`projects/refs/ref-cc-cleanroom` (ghuntley public) — 라이선스 없음(All rights reserved). 코드 복붙·재배포 금지. 패턴 reference로만 사용.

`projects/refs/ref-cc` (nextain private) — 분석 docs만 포함. 원본 source 1,884 files는 유실. 재추출 시도는 사용자 승인 필요.

### G4. 매트릭스 ID 인용 강제

매트릭스(§A/B/C/D/E/F)에 있는 항목을 다룰 때 commit message 또는 PR description에 ID 인용 (예: "fixes G03/D01"). 신규 결정은 매트릭스 §D에 항목 신설 후 ID 인용.

### G5. P0 라벨 sub-issue는 R1 진입 차단

OPEN P0 sub-issue (label `R0/P0` 또는 제목 prefix `[R0/P0]`)가 1건이라도 남아있으면 R1 plan 작성 차단.

현재 P0: #3, #4, #5, #6.

### G6. 슬라이스 머지 조건 (R1+)

`AGENTS.md` §"슬라이스 success criterion" 4가지 모두 충족. (c) 통합 검증 부재 PR 머지 거부.

## Claude가 자주 하는 실수 회피

- "Mock 그대로 두고 unit test만 추가" — 매트릭스 E04(Agent-level smoke 미존재) drift 강화. **금지**. 통합 검증 동시 도입.
- "여러 슬라이스 동시 진행" — Slice 1 종료 후 Slice 2 시작. 동시 작업 시 success criterion 검증 흐려짐.
- "기존 결정 재논의" — 매트릭스 §A는 변경 금지. 변경 필요 시 별도 ADR + 사용자 승인.

## 컨텍스트 SoT

본 레포 컨텍스트의 **Single Source of Truth**:

- 작업 규칙: `AGENTS.md` (사람·에이전트 공통)
- Claude 전용 추가: 본 `CLAUDE.md`
- 프로젝트 인덱스: `.agents/context/project-index.yaml`
- 룰 데이터: `.agents/context/agents-rules.json`

본 4개가 충돌하면 우선순위: `agents-rules.json` > `CLAUDE.md` > `AGENTS.md` > `project-index.yaml`.
