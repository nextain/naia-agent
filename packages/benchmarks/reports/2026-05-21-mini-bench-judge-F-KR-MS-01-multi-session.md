# Mini-bench (judge ensemble) — F-KR-MS-01-multi-session — 2026-05-21

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `realtime` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — FAIL (57540ms): Context provides daily food and sightseeing costs (11만원) but doesn't explicitly state the calculation of "식비+관광 100만원 / 여행 5일 = 1일 평균 약 20만원" as required by the criterion.
- `opencode` — PASS (29769ms): Discoveries에 "1일 11만원 기준 = 100만원이면 약 9일"로 식비+관광 총액 100만원이 명시되어 있고, tail 대화에서 여행 기간 5일(10월 5일-9일)이 확인되므로 100만원÷5일=20만원/일 산출에 충분한 정보가 모두 존재함.
- `codex` — PASS (12780ms): 문맥에 총예산 500만원과 항공 200만원·숙소 200만원, 그리고 확정 여행기간 10월 5일-9일의 5일이 모두 있어 남은 식비+관광 100만원을 5일로 나눠 1일 평균 약 20만원(대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (15438ms): The context includes the total budget (5 million KRW), fixed costs for flights and accommodation (4 million KRW total), and the finalized 5-day schedule, which allows calculating the remaining 1 milli

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (26621ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of 20만원.
- `opencode` — **INFRA** (19922ms): opencode reply unparseable (117 chars): 통과: 컨텍스트에는 세션 A의 식비+관광 100만원 예산과 세션 B의 여행 기간 5일(10월 5일~9일)이 모두 포함되어 있으며, 이는 100만원 ÷ 5일 = 일일 평균 약 20만원을 계산하는 데 충분합니다.

- `codex` — PASS (9732ms): Session A states 식비+관광 예산이 100만원이고 Session B states 여행 일정이 5일이므로 이를 합쳐 1일 평균 약 20만원(맥락상 대략 167유로)으로 계산할 수 있다.
- `gemini` — PASS (12807ms): 세션 A의 식비/관광 예산 100만원과 세션 B의 확정 일정 5일이 모두 포함되어 있어 일 평균 20만원 계산이 가능합니다.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9711ms): Context provides daily food+attraction cost (80,000 won) and trip duration (5 days) to calculate 80,000 won/day average.
- `opencode` — **INFRA** (31311ms): opencode reply unparseable (193 chars): 실패: 컨텍스트에는 총 예산 500, 항공 200, 숙소 200 및 5일 여행 기간이 포함되어 있어 간접적으로 100만원/5일 = 20만원 도출이 가능하지만, 명시적인 '식비+관광 100만원' 총액이나 5일에 걸쳐 
- `codex` — PASS (16275ms): 문맥에 총예산 500만원과 항공 200만원·숙소 200만원이 있어 식비+관광 예산이 100만원으로 남고, 현재 세션의 5일 일정(10월 5일-9일)도 있으므로 두 세션을 합쳐 100만원 ÷ 5일 = 하루 약 20만원(대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (18628ms): 컨텍스트에 총 예산 500만원, 고정 비용(항공 200/숙소 200)을 제외한 잔여 예산 100만원, 그리고 확정된 일정 5일이 모두 명시되어 있어 일평균 20만원 계산이 가능합니다.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (26425ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of approximately 20만원.
- `opencode` — PASS (8262ms): 세션 A에서 식비+관광 예산 100만원, 세션 B에서 여행 기간 5일(10월 5일-9일)을 확인할 수 있어 100만원 ÷ 5일 = 1일 평균 약 20만원 계산이 가능하다.
- `codex` — PASS (9438ms): Session A states 식비+관광 budget is 100만원 and Session B states the Paris trip is 5일, so the context is sufficient to compute a 1일 평균 예산 of about 20만원.
- `gemini` — PASS (13853ms): 세션 A의 식비 및 관광 예산 100만원과 세션 B의 여행 기간 5일이 모두 명시되어 있어 일 평균 20만원을 산출할 수 있는 충분한 정보가 포함되어 있습니다.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (20173ms): The context contains the total food+tourism budget (100만원) and trip duration (5 days) needed to calculate the average daily budget of 20만원.
- `opencode` — **INFRA** (16188ms): opencode reply unparseable (132 chars): 통과: 세션 A에서는 식비+관광에 100만원(초기에는 하루 약 11만원으로 추정됨)을 확정하고, 세션 B에서는 5일간의 여행 기간(10월 5일-9일)을 확정했으므로, 100만원 ÷ 5일 = 하루 평균 약 20만원을 
- `codex` — PASS (11125ms): Session A states 식비+관광 예산이 100만원이고 Session B gives 여행 기간이 5일이므로 두 세션을 합쳐 1일 평균 약 20만원으로 계산할 수 있다.
- `gemini` — PASS (14870ms): 세션 A의 식비+관광 예산 100만원과 세션 B의 여행 기간 5일이 명시되어 있어 1일 평균 약 20만원임을 계산할 수 있는 충분한 정보가 포함되어 있습니다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
