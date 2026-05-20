# Mini-bench (judge ensemble) — F-KR-MS-01-multi-session — 2026-05-20

- **Fixture**: F-KR-MS-01-multi-session (longmem-multi-session-reasoning)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (6992ms): Context lacks any budget figures (100 million KRW total or daily breakdown) needed for the required calculation.
- `opencode` — FAIL (5985ms): 컨텍스트에는 총 예산(100만원)과 일수(5일)가 명시적으로 언급되지 않았고, 식비·관관 항목별 금액도 없어 평균을 계산할 수 있는 정보가 부족하다.
- `codex` — FAIL (8057ms): CONTEXT에는 여행 기간 5일 정보만 있고 식비+관광 총액 100만원이 없어, 100만원 ÷ 5일 = 하루 약 20만원(약 167유로) 계산을 충족할 수 없습니다.
- `gemini` — FAIL (11343ms): The context mentions the 5-day duration but is missing the total budget figure of 100만원 mentioned in the pass criterion, making the daily average calculation impossible.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7028ms): CONTEXT lacks any budget figures (total cost or daily breakdown) needed to calculate the 1 million won ÷ 5 days = 200,000 won/day average.
- `opencode` — FAIL (9011ms): 컨텍스트에는 5일 일정 정보는 있으나 식비+관관 예산 100만원이라는 수치가 전혀 등장하지 않아, 일 평균 20만원 계산에 필요한 핵심 정보가 누락되어 있습니다.
- `codex` — FAIL (5786ms): CONTEXT에는 여행 기간 5일 정보만 있고 이전 세션의 식비+관광 총예산 100만원이 없어 하루 평균 약 20만원(≈167유로)을 계산할 근거가 부족합니다.
- `gemini` — FAIL (11244ms): The context mentions the 5-day duration but completely lacks the required total budget information (100만원) necessary to calculate the daily average.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16843ms): The context contains the total food and tourism budget (100만원) and trip duration (5일), allowing calculation of the average daily spending (20만원).
- `opencode` — PASS (6351ms): Session A에 식비+관광 100만원, Session B에 5일 일정이 있어 100만원 ÷ 5일 = 1일 평균 약 20만원(또는 약 167유로) 계산에 필요한 두 숫자가 모두 컨텍스트에 충실하게 존재함.
- `codex` — PASS (9855ms): Session A states 식비+관광 예산이 100만원이고 Session B states 여행이 5일이므로, 두 세션을 합치면 하루 평균 약 20만원(대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (9462ms): The context provides the 100만원 remaining budget for food and sightseeing from Session A and the 5-day trip duration (Oct 5-9) from Session B, enabling the calculation of 20만원 per day.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21279ms): The context contains the total food and tourism budget (1 million KRW) and trip duration (5 days), allowing calculation of the average daily spending (200,000 KRW/day or ~167 EUR/day).
- `opencode` — PASS (8568ms): Context에서 Session A의 식비+관광 예산 100만원과 Session B의 여행 기간 5일(10월 5일-9일)이 모두 제공되어, 100만원 ÷ 5일 = 일평균 약 20만원 계산이 가능하다.
- `codex` — PASS (7903ms): Session A states 식비+관광 예산이 총 100만원이고 Session B states 여행 일정이 5일이므로, 두 세션을 합쳐 하루 평균 약 20만원(문맥상 대략 167유로)로 계산할 수 있다.
- `gemini` — PASS (10429ms): The context identifies the 1,000,000 KRW food and sightseeing budget from Session A and the finalized 5-day trip duration from Session B.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
