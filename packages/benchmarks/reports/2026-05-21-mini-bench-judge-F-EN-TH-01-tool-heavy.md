# Mini-bench (judge ensemble) — F-EN-TH-01-tool-heavy — 2026-05-21

- **Fixture**: F-EN-TH-01-tool-heavy (tool-heavy)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.500 | 4.0 | 0 | 1.000 | 0.500 |
| `reactive-vercel` | 0.500 | 3.0 | 2 | 1.000 | 0.500 |
| `realtime` | 0.500 | 4.0 | 0 | 1.000 | 0.500 |
| `anthropic-native` | 0.000 | 3.5 | 1 | 1.000 | 0.500 |
| `off` | 0.000 | 4.0 | 0 | 1.000 | 0.500 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (49951ms): Context lacks hotel confirmation number, seafood reservation confirmation, and specific activities.
- `opencode` — FAIL (7745ms): The context contains neither the hotel booking confirmation LCH-2026-05-23-A7Q3 nor the seafood reservation confirmation RES-J-A4K7, and the activities list is truncated — the compacted recap only pre
- `codex` — FAIL (6275ms): The context only preserves weather and partial hotel search/selection details, but it does not contain the required hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7,
- `gemini` — FAIL (13147ms): The context lacks the specific hotel and seafood reservation confirmation numbers and the suggested activities required by the pass criterion.

**Probe 2** (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — FAIL (24309ms): The recap mentions Saturday as a topic but doesn't include the specific forecast details (sunny, 24°C high) that were established in turns 3 and 4.
- `opencode` — PASS (8277ms): The recap's tool_result section explicitly states "Saturday: sunny, high 24°C low 18°C" and the discoveries section reiterates "Saturday will be sunny with a high of 24°C", satisfying both required fa
- `codex` — PASS (9114ms): The recap explicitly preserves the Saturday Busan forecast as sunny with a high of 24°C, including a tool result stating Saturday: sunny, high 24°C low 18°C.
- `gemini` — PASS (12408ms): The context explicitly states that Saturday in Busan will be sunny with a high of 24°C in both the tool results and discoveries sections.

### `reactive-vercel`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (13305ms): Context lacks the hotel booking confirmation number LCH-2026-05-23-A7Q3 or equivalent, though it contains the seafood confirmation and two activities.
- `opencode` — FAIL (11561ms): Hotel booking confirmation number is missing from context — the hotel booking tool result was lost to truncation ("303 of 1698 chars retained"), so only the seafood confirmation RES-J-A4K7 and activit
- `codex` — FAIL (11230ms): The context includes the seafood reservation confirmation RES-J-A4K7 and mentions Haeundae/Jagalchi, but it omits the hotel booking confirmation number LCH-2026-05-23-A7Q3 and does not preserve a comp
- `gemini` — FAIL (11674ms): The context is missing the hotel booking confirmation number LCH-2026-05-23-A7Q3 due to truncation, making it impossible to satisfy the first requirement of the pass criterion.

**Probe 2** (after turn 19) — ensemble: ✅ PASS (2/4 valid)

- `glm` — PASS (11710ms): The context contains the specific Saturday weather forecast details "sunny" and "24°C" from the original assistant response.
- `opencode` — **INFRA** (7388ms): opencode reply unparseable (122 chars): 통과: 컨텍스트의 두 번째 턴에서 Busan의 토요일 예보를 명시적으로 명시했습니다: "Saturday will be sunny with a high of 24°C" — 'sunny'와 '24°C'가 모두 존재합니다
- `codex` — PASS (5841ms): The context explicitly states that in Busan this weekend Saturday would be sunny with a high of 24°C, which satisfies the required weather detail.
- `gemini` — **INFRA** (140334ms): gemini timed out after 90000ms

### `realtime`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7307ms): Context lacks hotel booking confirmation number, seafood reservation confirmation number, and specific activities.
- `opencode` — FAIL (15473ms): The hotel booking confirmation (LCH-2026-05-23-A7Q3), seafood reservation confirmation (RES-J-A4K7), and suggested activities are all absent — the context was truncated at the hotel search stage and n
- `codex` — FAIL (8040ms): The context only preserves weather and partial hotel search results, but it does not contain the required hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, or a faithful list of 
- `gemini` — FAIL (11941ms): The context is missing the specific hotel and seafood reservation confirmation numbers (LCH-2026-05-23-A7Q3 and RES-J-A4K7) and only mentions Haeundae without explicit suggested activities.

**Probe 2** (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (57906ms): The context includes the specific Saturday forecast of "sunny" with "24°C" high temperature as required by the criterion.
- `opencode` — PASS (11605ms): Context contains both the tool_result "Saturday: sunny, high 24°C low 18°C" and the discoveries recap "Saturday will be sunny with a high of 24°C", satisfying the requirement for 'sunny', 'Saturday', 
- `codex` — PASS (5068ms): The recap explicitly preserves the original Saturday forecast for Busan as sunny with a high of 24°C (and low 18°C), which satisfies the required weather detail.
- `gemini` — PASS (13383ms): The context explicitly includes both the tool result stating Saturday is sunny with a high of 24°C and the assistant's discovery confirming Saturday will be sunny with a high of 24°C.

### `anthropic-native`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (7109ms): Context lacks hotel booking confirmation number LCH-2026-05-23-A7Q3 required by the criterion.
- `opencode` — **INFRA** (12829ms): opencode reply unparseable (157 chars): 실패: 호텔 예약 확인 번호(LCH-2026-05-23-A7Q3)가 유지된 컨텍스트에 완전히 누락되어 있습니다. 해당 번호가 포함되었을 초기 대화 내용이 잘려 나갔습니다. 해산물 예약 확인 번호(RES-J-A4K7)
- `codex` — FAIL (10004ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several suggested activities like Haeundae Beach, Jagalchi Market, Gwangalli Beach, Dongbaek Park, Centum City, and BIFF Square
- `gemini` — FAIL (17048ms): The context is missing the mandatory hotel booking confirmation number LCH-2026-05-23-A7Q3 required by the pass criterion.

**Probe 2** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (22626ms): The context mentions Saturday is sunny but lacks the temperature detail of 24°C required by the criterion.
- `opencode` — FAIL (13408ms): The context retains "Saturday is sunny" (in assistant thinking) but the specific temperature "24°C" from the original forecast is absent — the truncation dropped the tool_result where the forecast det
- `codex` — FAIL (10196ms): The context preserves that Saturday was sunny but drops the required temperature detail 24°C/high 24, so it is insufficient to satisfy the criterion.
- `gemini` — FAIL (16334ms): The context mentions that Saturday is sunny but omits the 24°C temperature detail required by the pass criterion.

### `off`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (5904ms): Missing hotel booking confirmation number LCH-2026-05-23-A7Q3
- `opencode` — FAIL (8835ms): Hotel booking confirmation number LCH-2026-05-23-A7Q3 is absent — the context was truncated at 1131/2904 chars and the beginning containing the hotel booking is lost, while seafood confirmation RES-J-
- `codex` — FAIL (7310ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several suggested activities like Haeundae Beach, Jagalchi Market, Gwangalli, Dongbaek Park, Centum City, and BIFF Square, but 
- `gemini` — FAIL (12926ms): The hotel booking confirmation number LCH-2026-05-23-A7Q3 is not present in the provided context.

**Probe 2** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (20305ms): The context mentions Saturday is sunny but omits the required temperature detail (24°C).
- `opencode` — FAIL (13726ms): The retained context mentions "Saturday is sunny" in assistant thinking but the specific temperature "24°C" is absent — the original tool_result from turn 3 that established the forecast detail was lo
- `codex` — FAIL (5486ms): The context preserves that Saturday was sunny but drops the required 24°C high, so it lacks enough faithful detail to satisfy the criterion.
- `gemini` — FAIL (14038ms): The context mentions that Saturday is sunny but omits the specific temperature (24°C) required by the pass criterion.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
