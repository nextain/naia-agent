# Mini-bench (judge ensemble) — F-KR-MS-01-multi-session — 2026-05-21

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (13742ms): Context lacks any budget figures (total cost or daily average) needed to calculate the required 1 million KRW ÷ 5 days = 200,000 KRW/day.
- `opencode` — FAIL (11440ms): 컨텍스트에는 식비+관광 100만원이라는 예산 수치가 전혀 등장하지 않아 일평균 계산이 불가능하며, 이전 세션의 예산 합의가 압축 과정에서 유실되었다.
- `codex` — FAIL (11985ms): 이 컨텍스트에는 여행 기간 5일만 있고 이전 세션의 핵심 예산 정보인 식비+관광 총 100만원이 빠져 있어 하루 평균 약 20만원(약 167유로)을 계산할 수 없다
- `gemini` — FAIL (16715ms): The provided context lacks the total budget information (100만원) mentioned in the pass criterion, making it impossible to calculate the daily average.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (6530ms): CONTEXT lacks any budget figures or cost calculations for food/tourism, making the required 1M won/5days=200K won/day calculation impossible.
- `opencode` — FAIL (12753ms): 컨텍스트에는 5일 여행 일정은 포함되어 있으나, 식비와 관광에 할당된 총 예산(100만원)에 대한 정보가 전혀 없어 하루 평균 금액을 계산할 수 없습니다.
- `codex` — FAIL (9166ms): CONTEXT에는 여행 기간 5일만 있고 식비+관광 총예산 100만원이라는 이전 세션 핵심 정보가 없어 1일 평균 약 20만원(약 167유로) 계산을 충실하게 할 수 없다
- `gemini` — FAIL (15235ms): The total budget of 1,000,000 KRW (100만원) required by the pass criterion to calculate the daily average is missing from the context.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (35293ms): Context lacks any budget figures (1 million KRW total or 200,000 KRW daily) needed for the calculation.
- `opencode` — FAIL (13378ms): 컨텍스트에 식비+관광 예산 합계(100만원)가 전혀 등장하지 않아 1일 평균 20만원 계산에 필요한 핵심 정보가 누락되었습니다.
- `codex` — FAIL (10630ms): CONTEXT includes the 5-day trip length but omits the separate-session total budget of 식비+관광 100만원, so the required 100만원 ÷ 5일 = 하루 약 20만원(약 167유로) calculation cannot be made faithfully.
- `gemini` — FAIL (13201ms): The context contains the 5-day duration but lacks the 100만원 total budget figure required to perform the calculation specified in the pass criterion.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16285ms): The context contains the total food and tourism budget (1 million won) and trip duration (5 days), allowing calculation of the average daily spending (200,000 won or ~167 euros).
- `opencode` — PASS (13336ms): Session A에서 식비+관광 100만원과 1일 약 80유로(=11만원) 단가가, Session B에서 5일(10월5일-9일) 일정이 모두 제공되어 100만원÷5일=일 평균 약 20만원(또는 ~167유로) 계산에 필요한 두 세션 정보가 충분히 담겨 있다.
- `codex` — PASS (7606ms): Session A states 식비+관광 예산이 100만원이고 Session B gives 여행 일정이 5일이므로, 두 정보를 합쳐 하루 평균 약 20만원(대략 167유로)이라고 계산할 수 있다.
- `gemini` — PASS (11484ms): 세션 A의 식비 및 관광 예산 100만원과 세션 B의 여행 기간 5일 정보가 모두 포함되어 있어 일 평균 예산 계산이 가능합니다.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9794ms): Context contains total food+tourism budget (100 million won) and trip duration (5 days) for accurate daily average calculation.
- `opencode` — PASS (16340ms): Session A에서 식비+관광 총액 100만원을, Session B에서 여행 기간 5일을 각각 확인할 수 있어 100÷5=1일 평균 20만원 산출 가능.
- `codex` — PASS (16483ms): Session A states 식비+관광 예산이 100만원이고 Session B states 여행이 5일이므로, 두 세션을 합치면 하루 평균 약 20만원을 계산할 수 있다.
- `gemini` — PASS (12794ms): The context contains the total food and sightseeing budget of 1,000,000 won from Session A and the final itinerary duration of 5 days from Session B, allowing for the calculation of 200,000 won per da

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
