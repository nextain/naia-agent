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
**상태: DONE (슬라이스 게이트 4건 충족). 단, 실측이 cross-stack 블로커를 드러냄(아래).**

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
현재 gemini로는 memory-grounded 답변이 **전부 실패**(execution-error). 근본원인 raw 재현·확정:
- **naia-gateway(any-llm→Vertex)는 assistant `content`가 배열(content-parts)이면 거부, 문자열만 수용.**
  - `content="<recall>..</recall>"` → 820자 정상 응답.
  - `content=[{type:"text",text:".."}]` → **HTTP 500 `Input should be a valid string`**.
- agent 멀티홉 루프(`packages/core/src/agent.ts:358`)는 hop0 assistant 턴을 content-blocks(배열)로 `#history`에 push. `<recall>` 재생성 hop1에서 그 배열형 assistant를 게이트웨이로 되돌림 → 500 → agent가 삼켜 **빈 finalText** → `[agent stopped]`.
- **영향 범위 = recall뿐 아니라 tool-use 포함 모든 멀티홉** (prior assistant 턴을 재전송하는 모든 흐름). single-hop(마커 없는 답변)은 정상.
- 배제된 오답들(디버깅 기록): thinking-block 재feed(gemini streaming thinking=0로 반증) / max_tokens 부족(2048 적용 확인) / streaming vs non-streaming(게이트웨이는 둘 다 정상) / trailing-assistant 턴 구조(문자열이면 정상).

**수정 위치(사람 결정 필요, 둘 중 하나):**
1. **naia-agent**: VercelClient(또는 history 직렬화)가 single-text assistant content를 **문자열로 collapse**해 openai-compat 게이트웨이 호환. (core 변경 → ADR/matrix + 승인. 별도 슬라이스.)
2. **project-any-llm**: Vertex 어댑터가 assistant `content` **배열 파트 수용**(OpenAI 표준). (게이트웨이 서버 변경 → 배포 게이트.)
→ 권고: naia-agent 측 (1)이 근본적(게이트웨이 무관 견고성). 단 core 변경이라 Luke 승인 후 별도 슬라이스.

### 다음 (블로커 해소 후)
- 위 (1) 또는 (2) 해소 → 긍정 probe가 `used-needs-judge`에 도달 → **Slice 2: social-quality 판정 배선**(codex+claude 앙상블, Gemini 제외).
- Slice 3: 감정연상 2 + 취향 +1(총 4). Slice 4: report/fixture 녹화(CI 회귀).
- 미커밋 WIP는 슬라이스 게이트 충족했으므로 커밋 대상(브랜치 `feat/hexagonal-grpc-boundary` 위, humanlike 파일만 surgical add).
