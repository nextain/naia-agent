<!-- G0-4 draft — gh 실행 전 사용자 확인용. 외부 push=승인(#31 draft §9).
     #2 master = CLOSED 확인됨 → SB sub-issue 부모 = #31 우산(#2 아님). -->

# G0-4 — #31 우산 재프레이밍 + SB sub-issue (gh 실행 draft)

## A. #31 본문 교체 (gh issue edit 31 --body)

```markdown
# [R6] Agent Service Builder — naia-agent 풀셋 에이전트 서비스 빌더 (우산)

> **재프레이밍 (2026-05-17)**: 이 이슈는 "평가 프레임웍" 단독이 아니라
> **에이전트 서비스 빌더 우산**이다. 평가는 그 하위 품질 게이트(SB-3).

## 헤드라인
naia-agent 풀셋(LLM + persona/system-prompt + naia-memory + RAG +
orchestration)으로 **다양한 에이전트 서비스를 정의·운영·평가**하는 기반을
개인(naia-os) / 비즈니스(naia-business-adk) 2-layer 로 구축.
계기: 외부 에이전트 개발 의뢰 데모.

## 설계 SoT
`nextain/naia-adk : .agents/progress/agent-service-builder-architecture.md` v3
(3-라운드 cross-review: v1 ISSUES → v2 부분해소 → v3 surgical, **gemini v3
CLEAN / codex v2 지적 v3 전부 흡수**, 사용자 합의 2026-05-17).

## 핵심 결정 (Part A 정합)
- **신규 최상위 계약 0개**. manifest = naia-adk workspace 데이터 파일(비-계약,
  Part A 3-계약 불변). loader = naia-agent CLI(host, A.4). matrix §D50.
- RAG = 기존 `MemoryProvider.recall()` 흡수 (RetrievalCapable 신설 폐기).
- orchestration = 직렬 step = `Agent.sendStream()` 연결, D6 turn 재사용,
  B19/B20 회피 (LangChain/StateGraph 미도입). matrix §D51.
- governance = operate layer (naia-business-adk host 주입, manifest 미확장).

## Phase (gate-닫힘)
- Phase0: F08 실측✅(OPEN P0 0건)·F01✅(bin 실존)·cross-review✅·합의✅·§D PR✅
- Phase1 (qwen3.6-27b-dense): SB-1 → SB-2 → SB-3
- Phase2: SB-5 minicpm (ko-serve PAUSED 해제 의존)
- Phase3: SB-6 naia-business-adk operate layer

## Sub-tasks
- [ ] SB-1 manifest loader 최소
- [ ] SB-2 RAG via recall
- [ ] SB-3 평가 결합 (구 #31 헤드라인 = 이 하위로 흡수)
- [ ] SB-4 orchestration §4 (조건부)
- [ ] SB-5 minicpm (Phase2) / SB-6 business operate (Phase3)

## Cross-ref
- matrix §D50/D51 + §L (R6 변경이력)
- ko-serve(`nextain/naia-ko-serve`) PAUSED — Phase2 의존
- #2 master = CLOSED → 본 #31 이 R6 우산 (sub-task 는 본 이슈 하위)
```

## B. SB sub-issue (gh issue create, 부모=#31)

### SB-1
title: `[R6/SB-1] service manifest 스키마 + naia-agent CLI loader (qwen3.6-27b)`
body 요지: naia-adk/docs/service-manifest-schema.md 정의 + CLI-host loader
manifest→기존 HostContext 조립. S01 `naia-agent --service <m>` / S02 unit /
S03 fixture-replay(qwen) / S04 CHANGELOG / matrix §D50. 부모 #31.

### SB-2
title: `[R6/SB-2] RAG via MemoryProvider.recall (manifest rag.sources)`
body 요지: RetrievalCapable 신설 X. manifest rag.sources → recall(source-aware,
alpha-memory). S01 `--rag` / S02 unit / S03 실 alpha-memory / S04 / §D50.

### SB-3
title: `[R6/SB-3] agent-flow 평가 결합 (구 평가 프레임웍 헤드라인 흡수)`
body 요지: manifest eval.fixtures → 기존 realtime_stability 하니스 확장,
fixture-replay 우선(G15). qwen e2e(persona+RAG+memory). S01 `--eval` / S02 /
S03 fixture e2e / S04 / #31.

## C. matrix commit (naia-agent repo, dev-process)
`docs(matrix): R6 §D50/D51 + §L — agent-service-builder 우산 (3R cross-review)`
matrix_id_citation 면제(docs). Part A/§A/§B 무변경.
