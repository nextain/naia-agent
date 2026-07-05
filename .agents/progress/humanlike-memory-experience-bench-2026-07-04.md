---
session_id: ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205
session_ids:
  - e14912ec-25e3-46fa-b815-6f01896e1a8c  # origin (설계·검증)
  - ed6b7ccc-5cb7-49a3-b4d8-0ef998fcb205  # 라이브 러너 빌드
topic: 인간다움 기억 경험 벤치 (감정연상·과거취향) — naia-agent 통합 시나리오
date: 2026-07-04
status: in-progress
---

# 인간다움 기억 경험 벤치 — naia-agent 통합 시나리오

naia-memory `.agents/progress/cognitive-property-bench-2026-07-04.md`의 층2(경험) 후속.
naia-memory 단독 불가 → naia-agent 통합 루프에서 창발 측정.

## 목표 (루크 2026-07-04)
인간다움 = (1) **감정 기반 연상**(화제 전환 시 감정으로 연결된 과거 회상) (2) **과거에 근거한 취향(성격)**.
- 메인 대화 LLM = Gemini Flash 3.5, naia-memory 서브 LLM = Gemini 3.1 Flash Lite
- 가상 다중 멀티세션 대화 → agent+memory 루프 → 감정연상·취향적용 측정
- 판정 = 플래그십 앙상블(Claude Opus + GPT/Codex + Gemini) — "인간적이어야 하니 플래그십"

## 효율성 발견 (기존 인프라 재사용 — 바닥부터 X)
naia-agent에 이미 존재:
- **3-XR-G**: 통합 시나리오 26 + **LLM-as-judge 하네스**
- **3-XR-F**: 유저 관점 시나리오 22
- **3-XR-H**: **멀티-judge 앙상블**(GLM+Codex+Claude, `NAIA_JUDGE_ENSEMBLE=1` gate, 크레딧 보호)
- 메모리 통합(`--memory` LiteMemoryProvider / `examples/hardened-sqlite-host.ts` full v6.0)
- 멀티턴 REPL(`--repl`), LLM config(anthropic/openai/glm/vertex → Gemini)
- CI fixture-replay default, real-LLM은 KEY opt-in (G15)
→ **전략: 3-XR-G/H 하네스를 멀티세션 감정연상·취향 시나리오로 확장.**

## 설계 방법 = 플래그십 크로스 회의 (루크 지시)
Claude(나) 초안 → codex(GPT) + gemini 크로스 리뷰 → 종합. codex 크레딧 주의(1-2회).

## 플래그십 크로스 회의 결과 (2026-07-04)
- Claude(나) + codex(GPT-5.5) 강하게 수렴. gemini CLI = 인증오류(project ID 미설정) 불참 → **설정 필요(사람)**.
- **핵심 합의(가장 중요)**: **부정/대조 probe 필수.** 없으면 벤치가 "옛 기억 계속 끄집어내는 agent(creepy DB)"를 보상 = 인간다움의 정반대. 인간다움=선택적·적절을 조작화.

### 합의 설계 (v1 MVP)
- **4 수작성 멀티세션 시나리오** (감정연상 2 + 취향적용 2). 각: seed 세션 2 + distractor 세션 1 + probe 2(긍정 1 + 부정/대조 1).
- **probe별 사전 명세**: trigger 조건 / expected-memory 집합(1~2, 정확문구 아님) / **forbidden recall(사실 관련이나 사회적 부적절)** / timing 제약 / 허용 style(잠정적 "그러고 보니 조금…" vs "네가 말했잖아").
- **5-버킷 파이프라인 계측**(judge vibes 아닌 배선 계측):
  1. recall marker 미발화 → **agent recall-결정 실패**(memory 아님!)
  2. marker 발화, target fact 무반환 → **memory 검색 실패**
  3. fact 반환, 응답 미사용 → **agent 통합 실패**
  4. fact 사용, 판정 나쁨 → **응답 style 실패**
  5. fact 잘 사용 → pass
- **결정론 채점**: recall 시도 / target 반환 / target 사용 (marker 로그 + fact 존재 + 키워드/임베딩).
- **판정(플래그십 앙상블, social-quality 층만)**: 적절성+자연스러움+충실성 0~3, median. 판정자 = codex(GPT)+claude(+gemini 인증후). **Gemini는 SUT이므로 단독 판정 제외**(동일계열 편향).
- **셋업**: agent=Gemini Flash 3.5 + naia-memory 서브=Gemini 3.1 Flash Lite + SQLite 세션간 영속. real-Gemini opt-in, fixture=배관 회귀.
- **재사용**: cli-judge(codexJudge/geminiJudge)·ensemble runner·recall-bench-judge 패턴·agent --memory/--repl·LLM config. `packages/benchmarks` 확장.
- 취향적용이 감정연상보다 객관적 → 취향부터 착수하면 신호가 깨끗.

## 진행 로그
- 2026-07-04: naia-agent 컨텍스트 정독. 기존 3-XR-G/H 하네스 확인(재사용). 세션 바인딩.
- 2026-07-04: 설계 브리프 작성 → 플래그십 크로스 회의(codex 완료·gemini 인증불참) → 합의 설계 v1 MVP 확정(위).

## SUT LLM 배선 확정 (Vertex via any-llm 게이트웨이) — 루크 "vertex 써"
`project-any-llm/docker/config.naia.yml`가 Vertex Gemini 노출. 모델 ID:
- 메인 대화 = **`vertexai:gemini-3.5-flash`**
- 메모리 서브(사실추출/BG) = **`vertexai:gemini-3.1-flash-lite`**
- 게이트웨이 경유(openai-compat → GATEWAY_URL). `naia-settings/llm.json` 기본은 로컬 ollama(gemma3n e4b/e2b + bge-m3)이므로 벤치는 **오버라이드**.
- 자격증명: GATEWAY_URL + master key + Vertex 프로젝트 = env(any-llm/llm-key/naia-settings), **내 셸엔 미설정**. 라이브 실행 = 게이트웨이 기동 + env 로드 필요(서버 단계, 사람 게이트 [feedback_ai_leads_human_executes_serverenv]). 키 출력 금지.
- **결정론 채점 코어는 키 없이 빌드 가능** → 먼저 구축(codex 권고 첫 빌드).
- 판정자 CLI: codex present·auth OK. gemini CLI auth 오류 → Vertex 경유로 대체 or 앙상블서 제외(SUT 계열).

## 기존 인프라 실태 (재사용 맵)
`packages/benchmarks`: fixture 포맷 + runner + judges(cli-judge codex/gemini/opencode + glm + ensemble) + metrics + report. **단 runner는 fixture-replay 압축 벤치**(recap 정보보존 측정)이지 라이브 루프 아님. 멀티세션/취향 fixture 존재(F-KR-MS-01, F009).
`packages/runtime/src/bench/recall-bench-judge.ts`: 라이브 recall marker 벤치(round-trip). → 라이브 루프 토대.
**결론**: 인간다움 라이브 벤치 = 새 라이브-루프 러너 필요(fixture-replay 확장 아님). judges·metrics·fixture포맷은 재사용.

## 빌드 진행 — 결정론 코어 (키 불필요) ✅
`packages/benchmarks/src/humanlike/`:
- `types.ts`: HumanlikeScenario/Session/Probe(family·polarity·trigger·expectedMemorySet·forbiddenRecalls·style) + PipelineTrace + 5-버킷 PipelineOutcome.
- `pipeline.ts`: `classifyPipeline(trace, polarity)` 순수함수 — 5버킷 분류 + 부정 probe 판별(target 강제=creepy 실패, 미강제=abstain pass) + failureLayer 귀속. `summarize()`.
- `__tests__/pipeline.test.ts`: **9/9 통과**. typecheck clean.
- 채점 척추 = codex 권고 "deterministic scoring 먼저". 키·LLM 불필요.

## SUT 연결 검증 완료 ✅ (2026-07-04) — 언블록
- 키 위치: `data-private/key/llm-key.env` (age 볼트 복호화됨, 평문). `set -a; . llm-key.env; set +a`로 로드(값 출력 금지).
- 게이트웨이: **`https://naia-gateway-181404717065.asia-northeast3.run.app`** (Cloud Run, /health 200). openai-compat `/v1/chat/completions`.
- 인증: **NAIA_PROD_KEY** (200) 또는 GATEWAY_MASTER_KEY (200). NAIA_DEV_KEY=401(dev 게이트웨이용, 이 prod엔 불가).
- 모델 검증: `vertexai:gemini-3.5-flash`·`vertexai:gemini-3.1-flash-lite` 둘 다 200 + 실 콘텐츠 반환("hello from naia", finish=stop). ⚠ max_tokens 충분히(≥32) — 낮으면 thinking 소비로 choices 빈배열.
- → 라이브 러너를 이 검증된 경로 위에 구축 가능. 결정론 코어(9/9)와 결합.

## 남은 작업 (전부 언블록 — 라이브 러너 빌드)
1. **라이브 멀티세션 러너**: agent(gemini-3.5-flash) 턴루프 × 세션, naia-memory(sub=gemini-3.1-flash-lite) 영속, recall marker 계측 → PipelineTrace 생성. **any-llm 게이트웨이 URL/키 env 필요(사람)**.
2. **수작성 시나리오 4개**(취향2+감정2, seed2+distractor1+probe긍정1/부정1). 취향부터.
3. **social-quality 판정**: codexJudge+claude(+gemini via vertex) 앙상블, used-needs-judge 층만.
4. naia-agent 슬라이스 게이트(runnable cmd + integration) 충족 후 커밋. **현재 코어는 partial WIP(미커밋)** — 슬라이스 미완이라 커밋 보류.

## 핸드오프 (2026-07-04)
새 세션용 자족 핸드오프: **`HANDOFF-humanlike-live-runner-2026-07-04.md`**. 설계·검증연결·빌드플랜·함정 전부 포함. 라이브 러너는 새 집중 세션에서 시작(긴 세션 끝 대형빌드 회피).

## Slice HL-1 완료 (2026-07-04, session ed6b7ccc) — 라이브 러너 + 취향 시나리오 1개
**상태: DONE (게이트 4건 충족). 실측이 recall-regen 결함을 드러냄 → root-cause 후 core 수정·검증 완료(아래). 벤치가 이제 실제로 판별(긍정 used-needs-judge / 부정 abstained-correctly).**

빌드물:
- `packages/benchmarks/src/humanlike/observe.ts` — 순수 `buildTrace()`(관찰→트레이스) + `isDegenerateResponse()`(무응답=execution 실패 가드).
- `packages/benchmarks/src/humanlike/scenarios.ts` — `PREF_VEGETARIAN`(seed2+distractor1+긍정/부정 probe).
- `examples/humanlike-memory-bench.ts` — 라이브 러너(gemini-3.5-flash + 실 embedder text-multilingual-embedding-002 768d + LiteMemoryProvider 파일영속 + per-turn 격리 recall 스파이 + TeeLLM marker). `HUMANLIKE_LIVE=1` opt-in.
- unit 21 green(pipeline 9 + observe 12), 전체 benchmarks 49 green, typecheck clean.

설계 확정(빌드 중 규명):
- **embedder = 게이트웨이 실 Vertex 임베딩** (`vertexai:text-multilingual-embedding-002` 768d). 약한 해시 embedder는 의미 연상 측정 불가라 배제. ⚠ `OpenAICompatEmbeddingProvider`는 base가 `/openai`로 안 끝나면 `/v1/embeddings`를 스스로 붙임 → **bare `${GATEWAY}`** 넘겨야 함(`${GATEWAY}/v1` 넘기면 `/v1/v1/` 이중→404).
- **sub-LLM fact-extractor(gemini-3.1-flash-lite)는 Slice 2+ 이연** — LiteMemoryProvider는 verbatim 저장(LLM hook 없음). fact-extraction sub-LLM은 무거운 `MemorySystem`(naia-memory) 전용. 스켈레톤은 verbatim이 더 정직.
- **격리 유지**: start-of-turn recall을 per-turn 무력화([]) → target은 `<recall>` marker로만 도달 → 5-버킷 귀속(agent-decision vs memory-retrieval) 청결.

### ⚠⚠ 실측 발견 = **핵심 블로커** (naia-agent core / any-llm gateway, 사람 게이트)
벤치가 처음엔 모든 긍정 probe에서 `<recall>` 후 **빈 응답**(execution-error)을 냈다.

**⚠ 초기 진단(배열-content 게이트웨이 거부)은 틀렸다 — 정정.** dump→replay→bisect로 root-cause 확정:
- ❌ "게이트웨이가 assistant 배열 content 거부" 아님. wire 캡처 결과 SDK가 single-text content를 **문자열로 collapse**하고, raw 게이트웨이도 동일 shape에 **정상 응답(820자)**. (배열을 직접 쏘면 500이지만 SDK는 배열을 안 쏨.)
- ✅ **진짜 원인**: 마커 발화 후 history가 **assistant-마커 턴으로 끝나는 상태**에서 gemini가 regen 시 "marker mode"에 갇혀 빈 completion 반환. 지시형 persona("마커만 단독 출력")일수록 재현율↑.
- bisect(정확한 hop1 요청 dump 후 변형 replay): (a) trailing 마커 뒤 **user 턴 추가** → 정상(471~584자), (b) persona서 마커지시 제거 → 정상(1403자). persona 문구만 바꾸는 건 실패(구조적 continuation 필요).
- 배제된 오답: 배열-content / thinking-block 재feed(streaming thinking=0) / max_tokens(2048 적용) / streaming vs non-streaming(둘 다 정상) / trailing-assistant 구조 자체(문자열이면 정상).

**수정(적용·검증 완료) — Luke 승인대로 naia-agent 측:**
- `packages/core/src/agent.ts` — recall-regen에서 hits push 후 `continue` 전에 중립 `RECALL_CONTINUATION` user 턴 추가. trailing 마커 상태→user 종결 상태로 전환, 모델이 답하게 함. 언어중립.
- 회귀 테스트 `agent-recall-marker.test.ts`(regen msgs = user·assistant·user). runtime 741 pass, 회귀 0.
- **검증(real Gemini)**: 긍정 probe → `used-needs-judge`(채식 취향 떠올려 반영), 부정 probe → `abstained-correctly`. 벤치가 이제 실제로 판별함.

## Slice HL-2 완료 (2026-07-04, session ed6b7ccc) — social-quality 판정 배선
**상태: DONE (게이트 4건 충족). end-to-end 검증: 긍정 probe → PASS 2.83.**

빌드물:
- `packages/benchmarks/src/humanlike/judge.ts` — 순수 prompt/parse(엄격 4줄)/median/medianAxes/aggregate + `judgeSocialQuality`(codex+claude 패널). 3축(적절성·자연스러움·충실성) 0~3, 축별 median, overall(3축 평균)≥2.0=pass. infra 오류 판정자는 투표 제외, 전부 오류면 unreliable.
- `judges/cli-judge.ts` — `claude` CLI spec(`-p` print) + `claudeJudge` 추가, `runCli`/`CLI_SPECS`/`CliSpec` export(재사용). 기존 binary judges 무회귀(12 green).
- `examples/humanlike-memory-bench.ts` — `used-needs-judge` probe만 `NAIA_JUDGE_ENSEMBLE=1`서 판정. 요약에 judged pass 추가.
- unit 13(judge) 추가, benchmarks 62 green, typecheck clean.

**핵심 설계 발견 — 충실성 grounding:** 판정자에게 얇은 앵커(`expectedMemory:["채식"]`)만 주면, naia가 **실제 recall한** 세부(마파두부 등)를 "지어냈다"고 오판한다(1차 실행: 두 판정자 모두 FAIL 1.67). 격리 상태라 naia는 marker로 검색된 것만 가지므로, 충실성은 **실제 검색된 기억**(`recalledMemory` = markerDrivenHits) 기준으로 판정해야 공정. 배선 후 → PASS 2.83. (판정 입력 정확성 = 벤치 타당성.)

**검증(real codex+claude):** 긍정 probe end-to-end → PASS 2.83(적절 3/자연 2.5/충실 3), 판정자 2/2 valid. 판정 층이 fabrication을 잡고 충실·적절한 사용을 보상.

## Slice HL-3 완료 (2026-07-04, session ed6b7ccc) — 감정연상 시나리오 + 취향 +1 (총 4)
**상태: DONE (게이트 4건 충족). 4개 시나리오 all-live 검증, 벤치가 두 능력을 판별.**

빌드물:
- `scenarios.ts` — `EMO_DOG_LOSS`(반려견 상실 슬픔), `EMO_MARATHON`(완주 성취 격려), `PREF_COFFEE`(카페인 취향) 추가. 앵커 규율: "완주"(≠"마라톤"), "마루"(고유명사), "디카페인" — 그 기억을 끌어와야만 등장.
- `scenarios.test.ts`(new) — 구조 유닛 5(가족별 ≥2, 긍정/부정 쌍, 앵커 비어있지 않음, 부정은 forbiddenRecalls 보유, **모든 앵커가 seed 텍스트에 실제 등장=검색 가능**).
- 앵커 위생 수정: EMO-01-neg의 `"보낸"` 제거(→ "친구가 보낸 사진" false-match). used=Y가 이미 leak 정확히 잡음.
- benchmarks 67 green, typecheck clean.

**실측 발견 (all-4 결정론 실행, 8 probe):**
- 4 used-needs-judge / 3 abstained-correctly / 1 forced-inappropriate.
- **취향은 신뢰성 있게 작동** (긍정=used, 부정=abstain).
- **감정연상은 naia에게 더 어려움** — 긍정 probe가 실행 간 `not-used`↔`used-needs-judge`로 흔들림(검색은 되나 응답 통합 불안정, 때로 distractor 기억을 잘못 엮음). EMO-01 부정은 일관되게 forced-inappropriate(밝은 입양 맥락에 죽은 마루 끌어옴 = creepy DB 약점).
- → 벤치가 의도대로 두 능력을 판별. 감정 축이 취향 축보다 약하다는 것을 실증.

**캘리브레이션 과제 (정직·이연):**
- 단일 실행 판정은 감정 케이스에서 노이즈 큼(모델 비결정성). → Slice 4 fixture 녹화/다회 실행 안정화.
- 감정 **부정** probe는 취향 부정(부고)보다 경계 모호(상실을 부드럽게 언급=따뜻할 수도). 결정론 "surfaced=fail"이 여기선 과할 수 있음. 임계값 + 경계 부정을 판정층으로 라우팅할지 = 데이터 쌓인 뒤 튜닝.
- codex 크레딧: gated 판정은 필요시 1회만. Slice 3 검증은 결정론(판정 미실행)으로 절약.

## Slice HL-4 완료 (2026-07-04, session ed6b7ccc) — fixture record/replay + report
**상태: DONE (게이트 4건 충족). CI 재생 = LLM 없이 스코어링 파이프라인 회귀 방어.**

빌드물:
- `humanlike/fixture.ts` — `HumanlikeFixture`/`RecordedProbe`(관찰+koIncludes 해석된 trace+최종 bucket), `replayProbe`/`replayFixture`(순수: degenerate 가드→classifier, bucket drift 보고), `renderHumanlikeReport`(능력별 bucket·det pass/fail·판정 pass율).
- `fixtures/humanlike-v1.fixture.json` — 실 4-시나리오 Gemini 실행 8 probe 녹화.
- `examples/humanlike-memory-bench.ts` — `HUMANLIKE_RECORD=<path>` 녹화 + 능력별 report 출력.
- `fixture.test.ts`(new) 4 — 녹화 probe 전부 recorded bucket으로 재생(no drift)+극성↔판정 불변식+report. **key 없이 CI 실행.**
- benchmarks 71 green, typecheck clean.

**설계:** 판정(social-quality) 점수는 비결정·크레딧 게이트라 결정론 픽스처에서 제외(판정 집계는 judge.test.ts 유닛). 픽스처는 trace(koIncludes 해석)+bucket 저장 → 재생은 classifyPipeline+degenerate 가드 재실행 → 실 데이터에 대한 스코어링 회귀 방어.

**이연(정직):** 감정 케이스 비결정성 안정화용 다회 실행 집계는 이연 — run마다 fresh memory store 필요. 픽스처+report로 CI 회귀·리포트 가치를 먼저 확보. 판정 임계값(2.0) 캘리브레이션도 다회 데이터 쌓인 뒤.

## 4-슬라이스 완료 요약 (2026-07-04, session ed6b7ccc)
인간다움 기억 벤치 v1 = **결정론 5-버킷 + social-quality 판정** 2층 측정, real-Gemini opt-in + CI fixture-replay.
- HL-1: 라이브 러너 + 취향 시나리오 1 + 무응답 가드 (`slice-hl-1-humanlike-mem`)
- core fix: `<recall>` 재생성 continuation 턴(gemini 빈응답 해소) (동 브랜치)
- HL-2: social-quality 판정(codex+claude, 3축 median, 충실성=실검색기억 grounding) (`slice-hl-2-social-judge`)
- HL-3: 감정연상 2 + 취향 +1(총 4), 앵커 규율 (`slice-hl-3-emotion-scenarios`)
- HL-4: fixture record/replay + report + CI 회귀 (`slice-hl-4-fixture-report`)

**핵심 실증:** 취향 축은 신뢰성 작동, **감정 축은 naia에게 더 어려움**(긍정 not-used/retrieval-miss 흔들림, 부정 forced-inappropriate=creepy DB). 벤치가 벤치점수 놀음 없이 두 능력 차이를 정직히 판별.

**남은 캘리브레이션(사람/데이터):** ①다회 실행 안정화 ②판정 임계값 튜닝 ③감정 부정 probe 경계모호 → 판정층 라우팅 검토 ④codex=gated만.

## 매듭 (2026-07-05, session ed6b7ccc)
4-슬라이스 + core fix = 선형 체인, 브랜치 `migration/slice-hl-4-fixture-report`가 5커밋 전체 담은 superset (base `acf88e0`). **push/merge = 사람 게이트, 미실행.** 무관 WIP(coding-bench)는 미포함.

**감정 후속 방향 = 별도 세션 (루크 결정):** 이번 세션 설계 논의로 "감정=3겹 조립(누적 무게·접지된 상황·느린 창발 상태), 표현층만 변조·능력 불변, 접지>시뮬, legible 변주" 확정. naia-memory emotion gating을 실제로 켜는 cross-repo 작업이라 깨끗한 세션에서. **자족 핸드오프: `HANDOFF-grounded-affective-state-2026-07-05.md`.** 메모리 [[project_naia_emotion_grounded_affective_modulation]].
