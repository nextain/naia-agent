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
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 2.0 | 2 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (60910ms): The context contains the necessary information to calculate that the average daily budget for food and tourism is 20만원 (200,000 won) or 80유로, based on the total of 100만원 for 5 days.
- `opencode` — FAIL (29469ms): 컨텍스트에는 총예산 500만원, 항공 200, 숙소 200, 5일 일정이라는 원시 사실들이 분산되어 있으나, '식비+관광에 남은 예산 = 100만원'이라는 중간 계산과 '100만원 ÷ 5일 = 20만원'이라는 최종 결과가 명시되지 않아, 80유로/11만원(추천 식비+관광 1일액)과 혼동될 여지가 있어 정확한 1일 평균 산출에 필요한 연결 정보가 불충분하다.
- `codex` — PASS (17643ms): 컨텍스트에 총예산 500만원 중 항공 200만원·숙소 200만원은 별도라 식비+관광 예산이 100만원임이 드러나고, 후속 세션에 여행 기간이 10월 5일-9일의 5일로 있어 이를 합쳐 100만원÷5일=하루 약 20만원(대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (18004ms): The context identifies the total budget of 500만원 with 400만원 allocated to flights and lodging, leaving 100만원 for daily expenses, and confirms the finalized trip duration of 5 days (Oct 5-9).

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (55004ms): The context contains the total food+tourism budget (100만원) and trip duration (5일), allowing calculation of 1일 평균 20만원.
- `opencode` — PASS (22593ms): 세션 A에서 식비+관광 총액 100만원(1일 약 80유로=11만원)을 확인하고, 세션 B에서 여행 기간 5일(10월 5일-9일)을 확인할 수 있어 100만원÷5일=일 평균 약 20만원 계산이 가능하다.
- `codex` — PASS (23961ms): Session A states 식비+관광 예산이 100만원이고 Session B states 여행 일정이 5일이므로 두 세션을 합쳐 1일 평균 약 20만원(대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (13532ms): Context includes the 1 million KRW budget for food and sightseeing from the first session and the final 5-day duration from the second session, allowing for the calculation of 200,000 KRW per day.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (37446ms): The context provides daily food and tourism costs (30유로 and 50유로 respectively) but doesn't explicitly state the total food and tourism budget of 100만원 for the 5-day trip as required by the pass criter
- `opencode` — FAIL (7355ms): 컨텍스트는 식비+관광에 대해 하루 약 80유로 = 11만원을 명시하지만, 총 100만원을 5일 일정으로 나눈 약 20만원/일 계산은 포함하지 않아 기준에 부합하는 계산이 불가합니다.
- `codex` — PASS (11146ms): 컨텍스트에 총예산 500만원과 항공 200만원·숙소 200만원 배분이 있어 식비+관광 예산 100만원을 추론할 수 있고, 새 세션의 5일 일정과 합치면 1일 평균 약 20만원(≈167유로)로 계산 가능하다.
- `gemini` — PASS (18882ms): 컨텍스트의 Discoveries에 식비/관광 예산이 100만원임이 명시되어 있고, Session B에서 여행 일정이 5일로 확정되어 1일 평균 예산(20만원) 계산이 가능합니다.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (2/4 valid)

- `glm` — PASS (48648ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of 20만원.
- `opencode` — **INFRA** (12478ms): opencode reply unparseable (110 chars): 통과: 세션 A는 식비+관광에 100만원을, 세션 B는 여행 기간을 5일(10월 5일~9일)로 명시하여, 100만원 / 5일 = 하루 평균 약 20만원(또는 약 167유로)을 계산할 수 있습니다.

- `codex` — PASS (7925ms): Context includes that 식비+관광 예산은 100만원이고 later trip length is 10월 5일-9일의 5일이라, 두 세션을 합쳐 1일 평균 약 20만원(대략 167유로)으로 계산할 수 있다.
- `gemini` — **INFRA** (90836ms): gemini timed out after 90000ms

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (27098ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of 20만원.
- `opencode` — PASS (13189ms): 세션 A에서 식비+관광 총액 100만원, 세션 B에서 여행 기간 5일(10월5일-9일)이 모두 명시되어 있어 100만원÷5일=일평균 20만원 계산에 충분합니다.
- `codex` — PASS (8443ms): Context includes that 식비+관광 budget is 100만원 from Session A and the final trip length is 5일 from Session B, which is enough to compute a 1일 평균 약 20만원.
- `gemini` — PASS (12359ms): Context contains the 1 million KRW food/tourism budget from Session A and the 5-day duration from Session B, allowing for the calculation of 200,000 KRW per day.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
