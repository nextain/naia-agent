# Mini-bench (R7 / judge ensemble) — F-KR-MS-01-multi-session — 2026-05-22

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 | 5059 | 411/204 |
| `hermes` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 | 9810 | 810/386 |
| `reactive` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 | 1 | 0/0 |
| `naia+llm` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 | 8160 | 417/293 |
| `off` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14217ms): Context explicitly states "식비 + 관광이 100만원" and later confirms "5일" trip duration, enabling calculation of 1일 평균 20만원.
- `opencode` — PASS (20124ms): 컨텍스트는 세션 A의 식비+관광에 100만원과 세션 B의 5일 여행 기간을 모두 포함하고 있어, 에이전트가 100÷5=20만원/일을 계산할 수 있도록 합니다.
- `codex` — PASS (8115ms): 이전 세션에서 식비+관광 예산이 100만원으로 정해졌고 새 세션에서 여행 기간이 10월 5일-9일의 5일로 확정되어 있어 100만원을 5일로 나눈 1일 평균 약 20만원으로 계산할 수 있다.
- `gemini` — PASS (14146ms): Context explicitly mentions the 100만원 budget for food and sightseeing in the first session and the 5-day trip duration in the second session, enabling the calculation of a 20만원 daily average.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (5572ms): The context explicitly states "Total budget: 500만원" in the recap section under Constraints & Preferences.
- `opencode` — PASS (17455ms): 컨텍스트 요약에 명시적으로 'Total budget: 500만원'이 제약 조건으로 기록되어 있고 진행 상황에서도 반복적으로 확인되었습니다.
- `codex` — PASS (6093ms): recap explicitly states the user's total budget was 500만원, so the agent can answer with 500만원.
- `gemini` — PASS (12844ms): The recap section explicitly lists the total budget as 500만원 under Constraints & Preferences and the Progress section.

### `hermes`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10276ms): Context explicitly states 100만원 for food+tourism over 5 days, enabling calculation of 1일 평균 20만원.
- `opencode` — PASS (16585ms): 컨텍스트에는 세션 A의 식비+관광 100만원 정보와 세션 B의 5일 여행(10월 5일-9일) 정보가 모두 포함되어 있어, 100만원 ÷ 5일 = 1일 평균 약 20만원을 계산하기에 충분합니다.
- `codex` — PASS (6539ms): Context explicitly gives 식비+관광 총예산 100만원 in the earlier session and a later confirmed 5일 일정, so an honest agent can compute 1일 평균 약 20만원.
- `gemini` — PASS (13855ms): Context includes the total food and tourism budget of 1 million won from the first session and the confirmed 5-day schedule from the second session, allowing for the calculation of 200,000 won per day

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9016ms): The context explicitly states "총 예산: 500만원" in both the recap and critical context sections.
- `opencode` — **INFRA** (16712ms): opencode reply unparseable (135 chars): 통과: 컨텍스트의 여러 섹션(제약 조건 및 환경설정 "예산: 총 500만원", 완료된 작업 #4, 대기 중인 사용자 요청, 주요 컨텍스트)에 "총 500만원"이 명시되어 있으므로, 에이전트는 명확하게 "500만원"이
- `codex` — PASS (5587ms): 컨텍스트의 recap에 예산이 총 500만원으로 명시되어 있고 Completed Actions에도 사용자가 총 예산 500만원을 설정했다고 반복되어 있어 해당 답을 정확히 낼 수 있다.
- `gemini` — PASS (9757ms): Context explicitly states in multiple sections, including recap and critical context, that the total budget is 500만원.

### `reactive`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21791ms): Context provides 1,000,000 won budget for food+tourism from Session A and 5-day trip duration from Session B, enabling calculation of 200,000 won/day average.
- `opencode` — FAIL (43039ms): 컨텍스트에는 식비+관광 100만원(Session A 요약)과 5일 여행(Session B 꼬리)이 모두 포함되어 있어 — 에이전트는 100만원 ÷ 5일 = ~20만원/일을 직접 계산할 수 있으므로, 기준은 특정 산출을 요구하지만 컨텍스트에는 숫자들이 명시되어 있어 중간 계산(9일 기준 11만원/일)이 5일에 맞게 재계산되어야 하는데, 재계산이 아니라 이전의
- `codex` — PASS (7748ms): 컨텍스트에 이전 세션의 식비+관광 총액 100만원과 새 세션의 여행 기간 5일이 모두 있어 이를 합쳐 1일 평균 약 20만원(대략 167유로)로 계산할 수 있다
- `gemini` — PASS (12611ms): The context contains both the total food and sightseeing budget of 1 million KRW from the session recap and the final 5-day itinerary confirmed in the recent conversation.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6606ms): The context explicitly states "총 예산 500만원 확인" in the Discoveries section of the recap.
- `opencode` — PASS (6515ms): Discoveries 섹션에 "총 예산 500만원 확인"이 명시되어 있어, 에이전트는 500만원이라고 답변할 수 있다.
- `codex` — PASS (10840ms): Discoveries explicitly states 총 예산 500만원 확인, so the agent has enough context to answer that the initial total budget was 500만원.
- `gemini` — PASS (13390ms): Discoveries 섹션에 총 예산 500만원 확인이라는 문구가 명시되어 있어 질문에 대한 답변이 가능합니다.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6144ms): Context provides 100만원 for food+sightseeing over 5 days, enabling calculation of 1일 평균 20만원.
- `opencode` — PASS (19727ms): 컨텍스트에 식비+관광 총액 100만원(Session A recap)과 여행 기간 5일(10월 5일-9일, Session B tail)이 모두 포함되어 있어 100만원÷5일=약 20만원/일 계산이 가능하다.
- `codex` — PASS (7995ms): Context states food+sightseeing budget is 100만원 in Session A and the finalized trip length is 5 days in Session B, so an agent can compute the required 1일 평균 약 20만원(약 167유로).
- `gemini` — PASS (39740ms): The context identifies the total food and sightseeing budget as 1,000,000 KRW in Session A and the fixed trip duration as 5 days in Session B, allowing the calculation of 200,000 KRW per day.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (7528ms): The context explicitly states "The total budget confirmed for the vacation is 500만원" in the recap section.
- `opencode` — **INFRA** (9287ms): opencode reply unparseable (89 chars): 통과: 요약 recap에서 명시적으로 “휴가를 위해 확인된 총 예산은 500만원입니다”라고 명시하고 있어, 에이전트가 질문에 정확하게 답변하는 데 충분합니다.

- `codex` — PASS (5757ms): recap explicitly states the total budget confirmed for the vacation is 500만원, so the context contains the needed fact unambiguously.
- `gemini` — PASS (10853ms): The recap explicitly states that the total budget confirmed for the vacation is 500만원.

### `off`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13705ms): Context provides total food/tourism budget (1 million won) and trip duration (5 days), enabling calculation of 200,000 won/day average.
- `opencode` — PASS (9389ms): 세션 A는 식비+관광 총액 100만원과 1일 11만원(80유로) 견적을 제공하고, 세션 B는 5일 여행 기간을 확인하므로, 에이전트는 100만원 ÷ 5일 = 일 평균 약 20만원(또는 일일 약 167유로)을 계산하는 데 필요한 두 가지 숫자를 모두 확보할 수 있다.
- `codex` — PASS (5521ms): Session A states 식비+관광 예산이 100만원이고 Session B states the Paris trip is 5 days, so the context supports calculating a daily average of about 20만원 (roughly 167유로).
- `gemini` — PASS (13718ms): 세션 A에서 언급된 식비와 관광 예산 100만원과 세션 B에서 확정된 여행 기간 5일이 모두 포함되어 있어 일 평균 약 20만원을 산출할 수 있다.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11863ms): The context explicitly states the user's total budget as 500만원 in Session A.
- `opencode` — PASS (7717ms): 사용자가 세션 A에서 명시적으로 "예산은 총 500만원 잡고 있어요"라고 말했으며, 어시스턴트도 "총 예산 500만원 확인"으로 재확인함.
- `codex` — PASS (5112ms): Session A explicitly states 예산은 총 500만원 잡고 있어요 and the assistant confirms 총 예산 500만원, so the context unambiguously supplies the required answer.
- `gemini` — PASS (10951ms): Session A explicitly records the user stating a total budget of 5 million won (총 500만원) which the assistant confirms.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.