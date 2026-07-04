---
session_id_origin: e14912ec-25e3-46fa-b815-6f01896e1a8c
topic: HANDOFF — 인간다움 기억 경험 벤치 라이브 러너 빌드
date: 2026-07-04
status: ready-to-build (전부 언블록·검증됨)
audience: 새 세션 (이 대화 컨텍스트 없이 시작)
---

# HANDOFF: 인간다움 기억 경험 벤치 — 라이브 러너 빌드

이 문서 하나로 새 세션에서 바로 시작할 수 있게 자족적으로 작성함. 먼저
naia-agent 필수 컨텍스트(AGENTS.md + `.agents/context/agents-rules.json`)를 읽고,
이 문서의 형제 파일 `humanlike-memory-experience-bench-2026-07-04.md`(상세 이력)를 읽을 것.

## 0. 한 줄 요약
naia(agent + naia-memory)가 **인간처럼 기억**하는지를 라이브 다세션 대화로 측정하는
벤치를 짓는다. 결정론 채점 코어와 SUT 연결은 이미 빌드·검증됨. 남은 건 **라이브 러너 +
시나리오 + 판정 배선**.

## 1. 목표 (루크 정의, 절대 드리프트 금지)
"인간다움" = 두 가지 구체적 능력. **완벽 회상이 아님**(인간은 잘 잊는 게 좋은 기억):
1. **감정 기반 연상** — 화제가 바뀌어도 감정으로 연결된 과거 기억을 자연스럽게 떠올림.
2. **과거에 근거한 취향(성격)** — 여러 세션에 걸쳐 학습한 취향을 다시 안 알려줘도 적용.
- 북극성 메모리: `[[project_naia_memory_bench_northstar_humanlike]]`. SOTA 완벽회상 추격 금지, 과적합 배제.
- 왜 naia-agent에 사는가: 이 경험은 **agent 메인 LLM + memory 서브 LLM 통합 루프에서 창발**. naia-memory 단독 측정 불가(기질만 제공). naia-memory 쪽 이력 = `projects/naia-memory/.agents/progress/cognitive-property-bench-2026-07-04.md`.

## 2. 이미 빌드·검증된 것 (재사용, 다시 만들지 말 것)
### (a) 결정론 5-버킷 채점 코어 ✅ (키 불필요, 유닛 9/9 통과, typecheck clean)
`packages/benchmarks/src/humanlike/`
- `types.ts` — HumanlikeScenario/Session/Probe(family·polarity·triggerCondition·expectedMemorySet·forbiddenRecalls·acceptableStyle) + PipelineTrace + PipelineBucket/Outcome.
- `pipeline.ts` — `classifyPipeline(trace, polarity)` 순수함수 + `summarize()`.
- `__tests__/pipeline.test.ts` — 9 tests. 실행: `cd packages/benchmarks && pnpm exec vitest run src/humanlike/`
- **미커밋 WIP** (슬라이스 게이트=runnable+integration 미충족이라 보류). 러너 완성 후 슬라이스로 커밋.

### (b) SUT 연결 ✅ 검증됨 (2026-07-04, 실 200 응답 확인)
- 키: `data-private/key/llm-key.env` (age 볼트 이미 복호화, 평문). 로드: `set -a; . data-private/key/llm-key.env; set +a` (값 출력·argv/ps 노출 금지 — [[feedback_secret_var_print_safety]]).
- 게이트웨이: `https://naia-gateway-181404717065.asia-northeast3.run.app` (Cloud Run, openai-compat, `/health`=200, `/v1/chat/completions`).
- **인증 = NAIA_PROD_KEY** (200). GATEWAY_MASTER_KEY도 200. ⚠ NAIA_DEV_KEY는 401(dev용, 이 prod 게이트웨이엔 불가).
- 모델: 메인 `vertexai:gemini-3.5-flash`, 서브 `vertexai:gemini-3.1-flash-lite`. 둘 다 실 콘텐츠 반환 검증.
- ⚠ **max_tokens ≥ 32** (낮으면 thinking이 다 먹어 `choices:[]` 빈배열).
- 검증 스니펫(재현): `humanlike-memory-experience-bench-2026-07-04.md` "SUT 연결 검증" 절.

## 3. 합의 설계 (플래그십 크로스 회의: Claude + GPT-5.5)
- **부정/대조 probe 필수** (최중요). 없으면 "옛 기억 계속 끄집는 creepy DB"를 보상 = 인간다움 정반대. 각 시나리오에 긍정 probe(회상 적절) + 부정 probe(회상 부적절→agent가 강제하면 실패) 쌍.
- probe별 사전 명세: triggerCondition / expectedMemorySet(1~2, 정확문구 아님) / forbiddenRecalls / acceptableStyle(잠정형 "그러고 보니 조금…").
- **5-버킷 계층 귀속** (judge vibes 아닌 배선 계측):
  1. recall marker 미발화 → **agent 결정 실패**(memory 아님)
  2. 발화했으나 target 무반환 → **memory 검색 실패**
  3. 반환됐으나 응답 미사용 → **agent 통합 실패**
  4. 사용 → **used-needs-judge** (social-quality 판정으로)
  5. (부정 probe) 강제=creepy 실패 / 미강제=abstain pass
  → `classifyPipeline`이 이미 구현. 러너는 3개 boolean(recallAttempted/targetRetrieved/targetUsed) + forbiddenSurfaced만 채우면 됨.
- **판정 = 플래그십 앙상블, social-quality 층만**(적절성+자연스러움+충실성 0~3, median). 판정자 = codex(GPT) + claude. **Gemini는 SUT라 판정 제외**(동일계열 편향).

## 4. 재사용 인프라 (naia-agent 기존)
- `packages/benchmarks/src/judges/` — `codexJudge`/`geminiJudge`/`opencodeJudge`(cli-judge.ts) + `glmJudge` + `ensemble.ts` + `prompt.ts`. ⚠ gemini CLI는 인증오류(project ID 미설정)로 CLI 판정 불가 — Vertex 경유 or 앙상블서 제외.
- `packages/benchmarks/src/{metrics,report,fixture}.ts` — ProbeJudgement/factRecall/report 재사용.
- `packages/runtime/src/bench/recall-bench-judge.ts` — 라이브 recall marker 벤치(round-trip) + 한국어 judge. **라이브 루프의 토대** — 여기 패턴 확장.
- agent CLI: `--memory`(persistent), `--repl`(멀티턴), `--system`. recall marker `<recall>query</recall>` 프로토콜 이미 구현(agent.ts:250 파서).
- LLM config: `openai-compatible` backend + baseUrl(게이트웨이) + OPENAI_API_KEY(=NAIA_PROD_KEY). `docs/llm-config-standard.md`.

## 5. 빌드 플랜 (수직 슬라이스, 취향부터 — 감정보다 객관적)
- **Slice 1 — 라이브 러너 스켈레톤 + 취향 시나리오 1개**
  - 러너: 세션별로 agent(gemini-3.5-flash)를 seed 세션 대화 → naia-memory(sub=gemini-3.1-flash-lite) 영속 → probe 세션서 트리거 턴 실행 → recall marker 로그 + 반환 컨텍스트 + 응답 캡처 → PipelineTrace 채움 → `classifyPipeline`.
  - 취향 시나리오 1개(seed2 + distractor1 + probe 긍정1/부정1) 수작성.
  - verify: PipelineTrace가 채워지고 5-버킷 분류가 나오는지 (real Gemini opt-in).
- **Slice 2 — social-quality 판정 배선** (used-needs-judge 층에 codex+claude 앙상블).
- **Slice 3 — 감정연상 시나리오 2 + 취향 시나리오 +1** (총 4). 부정 probe 포함.
- **Slice 4 — report + fixture 녹화**(CI 회귀), 슬라이스 게이트 충족 → 커밋.
- 각 슬라이스: naia-agent success criterion(runnable cmd + unit + integration + CHANGELOG) 충족. 브랜치 `migration/slice-{N}-humanlike-mem`.

## 6. 함정 / 금지 (드리프트 방지)
- **완벽회상 추격 금지** — 부정 probe로 선택성 측정이 핵심.
- **naia-memory를 naia-kb-compiler에 직접 결합 금지** — RAG 오케스트레이션은 naia-agent 층 책임. kb-compiler 연결은 별도 논의(루크 관심사이나 이 벤치 범위 밖).
- **recall@k(fact-bank v2) 지표 쓰지 말 것** — 그 라벨은 단일-gold 검색용 아님(LLM-judge 답변평가용). naia-memory 이력서 규명됨.
- **감쇠/삭제**: naia-memory는 이미 archive-only(splice 안 함, 복구가능). 진짜 삭제는 storage 압력시만(#29 미구현). 이 벤치 범위 밖.
- **과적합 금지** — 키워드로 합성 anchor 잡기 X. importance 점수는 fact/filler 미구분(검증됨).
- **naia-agent 규칙**: karpathy 4원칙(Think Before Coding·Simplicity·Surgical·Goal-Driven). 매트릭스 ID 인용. Mock만 두고 unit만 추가 금지(통합 동시).
- **크레딧**: `NAIA_JUDGE_ENSEMBLE=1` 게이트로 판정 앙상블 opt-in. real-LLM opt-in, CI는 fixture-replay.

## 7. 시작 체크리스트 (새 세션)
1. naia-agent AGENTS.md + agents-rules.json 재독. 세션을 progress 파일에 바인딩(session_id).
2. `humanlike-memory-experience-bench-2026-07-04.md` 정독(설계 상세).
3. `packages/benchmarks/src/humanlike/` 코어 + 테스트 확인(9/9).
4. SUT 연결 재검증(§2b 스니펫, NAIA_PROD_KEY).
5. Slice 1 착수: 라이브 러너 + 취향 시나리오 1개.
