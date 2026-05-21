# Mini-bench (judge ensemble) — F-KR-MS-01-multi-session — 2026-05-21

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21715ms): The context provides the daily food cost (30유로) and tourism cost (50유로), allowing calculation of 1일 평균 80유로 (약 11만원) for food and tourism combined.
- `opencode` — PASS (27708ms): Context에서 총예산 500만원 중 항공 200+숙소 200=400만원은 별도로 명시되어 남은 100만원이 식비+관광에 해당하고, Session B에서 여행 기간이 5일로 확정되어 100만원÷5일=20만원/일 계산이 가능하다.
- `codex` — PASS (11609ms): 컨텍스트에 총예산 500만원과 항공 200만원·숙소 200만원이 남아 있어 식비+관광 예산 100만원을 도출할 수 있고, 새 세션의 5일 일정과 결합해 1일 평균 약 20만원(대략 167유로)으로 계산할 수 있다.
- `gemini` — PASS (32336ms): The context contains the total budget (5M KRW), fixed costs for travel and lodging (4M KRW total), the resulting remainder for food/sightseeing (1M KRW), and the user's finalized 5-day itinerary.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15267ms): The context contains the total food+tourism budget (100 million won) and trip duration (5 days), allowing calculation of the average daily budget (20 million won or ~167 euros).
- `opencode` — PASS (13774ms): 세션 A에서 식비+관광 100만원, 세션 B에서 10월 5일-9일 5일 여행 일정을 모두 확인할 수 있어, 100만원 ÷ 5일 = 1일 평균 20만원 계산이 가능하다.
- `codex` — PASS (9261ms): CONTEXT includes Session A's 식비+관광 총예산 100만원 and Session B's 확정 여행기간 10월 5일-9일 5일, so the agent can correctly compute 1일 평균 약 20만원(대략 167유로).
- `gemini` — PASS (13005ms): 세션 A의 식비+관광 예산 100만원과 세션 B에서 확정된 5일의 여행 기간 정보가 모두 포함되어 있어 일 평균 20만원 산출이 가능합니다.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (29467ms): Context contains total food/tourism budget (100 million won) and trip duration (5 days) for calculating 20,000 won daily average.
- `opencode` — FAIL (8349ms): 컨텍스트는 식비+관광에 대해 하루 약 80유로 = 11만원만 명시하며, 총 100만원을 언급하지만, 그것이 약 9일에 걸친 것임을 나타냅니다. 5일 여행 기간 동안 100만원을 5로 나누어 계산해야 한다는 5일 일정은 리캡의 발견 섹션에 포함되지 않았습니다.
- `codex` — PASS (13148ms): 컨텍스트에 총예산 500만원과 항공 200만원·숙소 200만원이 남겨져 식비+관광 예산이 100만원임이 드러나고, 후속 세션에 여행 기간이 10월 5일-9일의 5일로 있어 100만원÷5일=하루 약 20만원(약 167유로)로 계산할 수 있다.
- `gemini` — PASS (12779ms): Discoveries in context state a remaining budget of 100만원 for food/sightseeing, and Session B confirms a 5-day trip duration, allowing for the calculation of 20만원 per day.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (43755ms): The context contains the total food + tourism budget (100만원) and trip duration (5 days), allowing calculation of 1일 평균 약 20만원.
- `opencode` — PASS (12515ms): 세션 A에서 식비+관광 총 100만원이, 세션 B에서 5일(10월 5일-9일) 일정이 모두 명시되어 있어 100만원÷5일=일 평균 20만원 계산에 충분한 정보가 컨텍스트에 존재함.
- `codex` — PASS (7968ms): Session A states 식비+관광 예산이 100만원이고 Session B states 파리 여행이 5일이므로, 두 세션을 합치면 1일 평균 예산은 약 20만원이라고 계산할 수 있다.
- `gemini` — PASS (13776ms): 세션 A에서 식비와 관광비 총액이 100만원임이 명시되어 있고, 세션 B에서 여행 일정이 5일로 확정되었으므로 1일 평균 예산(20만원)을 산출할 수 있는 정보가 모두 포함되어 있다.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14193ms): The context contains the necessary information to calculate that the user's average daily budget for food and tourism is 20 million KRW (100 million KRW total / 5 days).
- `opencode` — FAIL (13295ms): 컨텍스트는 식비+관광 100만원과 1일 11만원(80유로) 기준, 그리고 5일 일정을 각각 제공하지만, 두 값을 결합해 100만원÷5일=20만원/일이라는 계산 결과는 명시적으로 포함되어 있지 않아 에이전트가 직접 산술해야 한다.
- `codex` — PASS (8862ms): Session A states 식비+관광 예산이 100만원이고 Session B states the Paris trip is 10월 5일-9일의 5일이므로, 두 세션을 합쳐 1일 평균 약 20만원으로 계산할 수 있다.
- `gemini` — PASS (13527ms): 세션 A에서 식비와 관광 예산 총액이 100만원임이 명시되어 있고 세션 B에서 여행 기간이 5일임이 확정되어 있어 1일 평균 20만원을 계산할 수 있는 정보가 모두 존재한다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
