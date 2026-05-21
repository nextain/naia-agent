# Mini-bench (judge ensemble) — F-KR-MS-01-multi-session — 2026-05-21

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `reactive-vercel` | 0.000 | 3.0 | 1 | 0.000 | 0.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9376ms): Context contains the required calculation components: 1 million KRW allocated for daily expenses over 5 days.
- `opencode` — **INFRA** (19701ms): opencode reply unparseable (153 chars): 통과: 컨텍스트는 총 500만원 중 항공 200 + 숙소 200 (별도)를 보여주어 식비+관광에 100만원이 남고, 확인된 5일 여행기간(10월 5-9일)과 결합하여 100만원 / 5일 = 20만원/일 또는 기록된 
- `codex` — PASS (12850ms): 컨텍스트에 총예산 500만원과 항공 200만원·숙소 200만원 배분, 그리고 새 세션의 5일 일정이 모두 있어 남은 식비+관광 100만원을 5일로 나눠 1일 평균 약 20만원(약 167유로)으로 계산할 수 있다.
- `gemini` — PASS (15819ms): Context provides the total budget (500만원), costs for flights (200만원) and accommodation (200만원), and the fixed 5-day trip duration, enabling the calculation of the 20만원 daily average.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (10666ms): Context lacks trip duration (5 days) needed to calculate 100만원 ÷ 5일 = 1일 평균 20만원.
- `opencode` — FAIL (20287ms): 세션 B의 콘텐츠가 잘려서(“Session B — 2026-04-20” 이후에 아무것도 보이지 않음) 완전히 누락되어 있으며, 이는 핵심적인 5일 여행 기간을 포함하고 있을 것입니다. 이 기간 없이는 식비+관광 100만 원을 일일 평균 약 20만 원으로 나눌 수 없습니다.
- `codex` — FAIL (11580ms): 문맥에는 Session A의 식비+관광 100만원과 1일 11만원 정보만 있고, PASS 기준에 필요한 Session B의 5일 여행 정보가 없어 100만원÷5일 계산을 할 수 없습니다.
- `gemini` — **INFRA** (134847ms): gemini timed out after 90000ms

### `realtime`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9418ms): Context contains 80유로/일 식비+관광 합계와 5일 일정으로 1일 평균 약 11만원 계산 가능.
- `opencode` — FAIL (60615ms): CONTEXT에는 1일 식비+관광을 11만원(80유로)으로 명시하고 "100만원이면 약 9일"이라고 기술하여, 100만원÷5일=20만원 계산에 필요한 '식비+관광에 배정된 총액이 100만원'이라는 사실이 항공·숙소 잔액으로서 명시되지 않고 9일분 예산으로 서술되어, 두 세션 정보를 결합해 20만원/일을 도출하는 데 필요한 핵심 연결(잔액 100만원이 5일에
- `codex` — PASS (10480ms): 컨텍스트에 총예산 500만원과 항공 200만원·숙소 200만원이 있어 식비+관광 잔여예산 100만원을 계산할 수 있고, 후속 세션의 5일 일정과 합치면 1일 평균 약 20만원(대략 167유로)로 답할 수 있다.
- `gemini` — FAIL (16617ms): Discoveries section states a 1-day budget is 11만원 (80 euros) based on a 100만원 total over 9 days, which contradicts the calculation of 20만원 per day for a 5-day trip required by the pass criterion.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13007ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of 20만원.
- `opencode` — PASS (9745ms): 컨텍스트에는 세션 A의 식비+관광 100만원과 세션 B의 5일(10월 5-9일) 일정이 모두 포함되어 있어, 100만원 ÷ 5일 = 1일 평균 약 20만원의 계산이 가능하다.
- `codex` — PASS (9023ms): Session A states 식비+관광 예산이 100만원이고 Session B states 여행 일정이 5일이므로, 두 세션을 합쳐 1일 평균 약 20만원(대략 167유로)으로 계산할 수 있다.
- `gemini` — PASS (13118ms): Context includes the 1 million KRW food/sightseeing budget from Session A and the 5-day trip duration from Session B, allowing for the calculation of 200,000 KRW per day.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21799ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of approximately 20만원.
- `opencode` — PASS (14653ms): 컨텍스트는 세션 A의 식비+관광 100만원과 세션 B의 여행 기간 5일을 모두 제공하여, 100만원 ÷ 5일 = 1일 평균 약 20만원을 계산할 수 있도록 한다.
- `codex` — PASS (7572ms): Session A states 식비+관광 예산이 100만원이고 Session B states 여행 일정이 5일이므로, 두 세션을 합치면 1일 평균 예산은 약 20만원(대략 167유로)으로 계산할 수 있다.
- `gemini` — PASS (25096ms): 세션 A의 식비+관광 예산 100만원과 세션 B의 여행 일정 5일 정보가 모두 포함되어 있어 일평균 20만원 산출이 가능합니다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
