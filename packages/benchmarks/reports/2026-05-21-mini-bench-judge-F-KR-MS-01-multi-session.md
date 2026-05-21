# Mini-bench (R7 / judge ensemble) — F-KR-MS-01-multi-session — 2026-05-21

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 |
| `reactive-vercel` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 |
| `realtime` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 |
| `off` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8251ms): Context provides both the total food+attraction budget (100만원) and trip duration (5일), enabling calculation of 1일 평균 20만원.
- `opencode` — FAIL (8839ms): 컨텍스트는 명시적으로 "식비는 하루 30유로, 관광은 50유로 잡으면 1일 약 80유로 = 11만원"으로 명시하여 5일 여행의 1일 평균 약 20만원을 계산하는 데 필요한 "식비+관광 100만원"의 총계가 아닌 1일 11만원의 수치를 제공한다.
- `codex` — PASS (11380ms): Context states the total budget is 500만원 with 항공 200만원 and 숙소 200만원, leaving 100만원 for 식비+관광, and Session B fixes the trip at 5일, so an honest agent can compute about 20만원 per day (roughly 167유로).
- `gemini` — PASS (13571ms): Discoveries section provides the total budget (500) and air/hotel costs (200+200), leaving 100 for other expenses, while the conversation tail specifies a 5-day duration, allowing the calculation of 2

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13524ms): The context explicitly states "총 예산 500만원 확인" in the Discoveries section.
- `opencode` — PASS (7409ms): Discoveries에 "총 예산 500만원 확인"이 명시되어 있어 질문에 답하기 충분하다.
- `codex` — PASS (10956ms): recap의 Discoveries에 총 예산 500만원 확인이라고 명시되어 있어 질문에 500만원으로 답할 충분한 근거가 있다.
- `gemini` — PASS (9028ms): Discoveries section explicitly confirms the total budget as 500만원.

### `reactive-vercel`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11918ms): The context contains both the total food+tourism budget (100만원) and trip duration (5일), allowing calculation of 1일 평균 20만원.
- `opencode` — PASS (13385ms): 컨텍스트에는 세션 A의 식비+관광 100만원과 세션 B의 여행 기간 5일(10월 5일-9일)이 모두 포함되어 있어, 에이전트가 100만원 ÷ 5일 = 하루 평균 약 20만원을 계산할 수 있습니다.
- `codex` — PASS (7764ms): Context states 식비+관광 예산이 100만원이고 later fixes the Paris trip at 5일, so an agent can compute 100만원 ÷ 5 = 1일 평균 약 20만원.
- `gemini` — PASS (18101ms): The context contains the total food and tourism budget of 1,000,000 won from Session A and the final 5-day itinerary from Session B, enabling the required calculation of 200,000 won per day.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16661ms): The context explicitly states the user's total budget as "총 500만원" in the fifth message.
- `opencode` — PASS (4907ms): Context clearly contains "예산은 총 500만원 잡고 있어요" and "총 예산 500만원 확인" in the first session, providing unambiguous information to answer 500만원.
- `codex` — PASS (8975ms): Context explicitly states in the first session that the user said 예산은 총 500만원 잡고 있어요, so the agent can answer 500만원.
- `gemini` — PASS (12276ms): The context explicitly records the user stating their total budget is 500만원 in the first session.

### `realtime`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11663ms): Context provides 1 million KRW daily budget (Session A) and 5-day trip duration (Session B), enabling calculation of 1,000,000 ÷ 5 = 200,000 KRW/day average.
- `opencode` — FAIL (6209ms): 컨텍스트에는 식비+관광 1일 약 80유로=11만원과 총예산 500만원이 나오지만, 5일 기준으로 합산해 1일 평균 약 20만원/167유로라는 계산에 필요한 "식비+관광 총합 100만원" 명시가 없어 해당 산출을 도출하기 어렵다.
- `codex` — PASS (11378ms): 컨텍스트에 총예산 500만원과 항공 200만원·숙소 200만원이 있어 식비+관광 예산이 100만원으로 남고, 후속 세션에 여행이 5일(10월 5일-9일)로 확정되어 있어 1일 평균 약 20만원(대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (12743ms): Context includes the total budget breakdown (500 total, 200 flight, 200 accommodation) and the confirmed trip duration of 5 days, allowing the calculation of a 20만원 daily average for food and sightsee

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (7034ms): The context explicitly states "총 예산 500만원 확인" in the Discoveries section.
- `opencode` — **INFRA** (5700ms): opencode reply unparseable (78 chars): 통과: 컨텍스트의 '발견 사항' 섹션에 '총 예산 500만원 확인'이라고 명시되어 있어 질문에 500만원이라고 명확하게 답할 수 있습니다.

- `codex` — PASS (5631ms): recap에 총 예산 500만원 확인이라고 명시되어 있어 처음 상담 시 알려준 총 예산을 500만원으로 답할 수 있다
- `gemini` — PASS (9656ms): The recap section under Discoveries explicitly states 총 예산 500만원 확인, providing the exact figure required by the pass criterion.

### `off`

**Probe 1** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (8649ms): Context provides total food/tourism budget (1 million won) and trip duration (5 days), enabling calculation of 1-day average (200,000 won).
- `opencode` — **INFRA** (8144ms): opencode reply unparseable (183 chars): 실패: 컨텍스트는 식비+관광(100만 원)과 총 기간(5일)을 모두 포함하지만, "식비+관광 100만 원 / 5일 = 20만 원/일"로 계산하는 데 필요한 나눗셈은 명시적으로 수행되지 않았으며, 1일 예산에 대한 이
- `codex` — PASS (7981ms): Session A states 식비+관광 예산이 100만원이고 Session B fixes the Paris trip at 5일, so the context is sufficient to compute 1일 평균 약 20만원.
- `gemini` — PASS (10887ms): 세션 A에서 언급된 식비와 관광 예산 100만 원과 세션 B에서 확정된 5일간의 일정 정보가 모두 포함되어 있어 하루 평균 20만 원 산출이 가능함.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (32995ms): The user explicitly stated "총 500만원 잡고 있어요" in the first session, and the assistant confirmed "총 예산 500만원 확인."
- `opencode` — PASS (5916ms): 세션 A에서 사용자가 명시적으로 "예산은 총 500만원 잡고 있어요"라고 말했고, 어시스턴트도 "총 예산 500만원 확인"하여 예산이 500만원임을 명확히 하므로, 이 질문에 답하기 위해 컨텍스트가 충분합니다.
- `codex` — PASS (6401ms): Session A explicitly states 예산은 총 500만원 잡고 있어요 and the assistant confirms 총 예산 500만원, so the context unambiguously supports answering 500만원.
- `gemini` — PASS (9089ms): Session A context explicitly states the user's total budget is 500 million won and the assistant confirms it.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.