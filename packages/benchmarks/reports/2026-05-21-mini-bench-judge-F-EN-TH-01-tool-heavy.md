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
| `anthropic-native` | 0.000 | 4.0 | 0 | 1.000 | 0.500 |
| `off` | 0.000 | 4.0 | 0 | 1.000 | 0.500 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7206ms): Context lacks hotel confirmation number, seafood reservation confirmation, and specific activity details.
- `opencode` — FAIL (13048ms): The context contains no hotel booking confirmation number (LCH-2026-05-23-A7Q3), no seafood reservation confirmation (RES-J-A4K7), and no clearly enumerated suggested activities — the context is trunc
- `codex` — FAIL (26217ms): The context only preserves weather and hotel search results plus a note about confirming Lotte City Hotel, but it does not include the required hotel confirmation LCH-2026-05-23-A7Q3, seafood reservat
- `gemini` — FAIL (12991ms): The context lacks the specific hotel booking confirmation (LCH-2026-05-23-A7Q3) and seafood reservation confirmation (RES-J-A4K7) numbers, as well as any specific suggested activities beyond the gener

**Probe 2** (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10988ms): The context contains the Saturday weather forecast (sunny, 24°C high) in the recap section, satisfying the requirement for both 'sunny' and temperature details.
- `opencode` — FAIL (15016ms): Recap preserves "sunny" and "24°C" in the tool_result summary and discoveries, satisfying the criterion — but wait, re-evaluating: the CONTEXT does contain "Saturday: sunny, high 24°C low 18°C" in the
- `codex` — PASS (6660ms): The context explicitly preserves the Saturday Busan forecast as sunny with a high of 24°C, including both the tool result and assistant summary.
- `gemini` — PASS (15308ms): The context explicitly lists the Saturday forecast for Busan as sunny with a high of 24°C within the tool results and discoveries sections.

### `reactive-vercel`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (37448ms): Context is missing the hotel booking confirmation number needed to satisfy criterion (a).
- `opencode` — FAIL (11733ms): Hotel booking confirmation number (LCH-2026-05-23-A7Q3) is lost in the truncated portion of context — the hotel booking tool_use call and its result were cut, leaving only the seafood reservation (RES
- `codex` — FAIL (16562ms): The context includes the seafood confirmation RES-J-A4K7 and activities like Haeundae Beach and Jagalchi Market, but it omits the hotel booking confirmation number LCH-2026-05-23-A7Q3 due to truncatio
- `gemini` — FAIL (11993ms): The context is missing the hotel booking confirmation number (LCH-2026-05-23-A7Q3) due to provider truncation occurring between the hotel tool call and the seafood tool result.

**Probe 2** (after turn 19) — ensemble: ✅ PASS (2/4 valid)

- `glm` — PASS (9326ms): The context contains the Saturday weather forecast for Busan as "sunny with a high of 24°C" which satisfies the requirement to include both 'sunny' and the temperature '24°C'.
- `opencode` — **INFRA** (9468ms): opencode reply unparseable (101 chars): 통과: 컨텍스트의 첫 번째 어시스턴트 턴은 "토요일은 맑고 최고 기온이 섭씨 24도입니다"라고 명시하여, 두 가지 요구되는 사실(맑음, 섭씨 24도)을 모두 명시적으로 제공합니다.

- `codex` — PASS (6609ms): The context explicitly states that Saturday in Busan would be sunny with a high of 24°C, which directly satisfies the required weather detail.
- `gemini` — **INFRA** (126635ms): gemini timed out after 90000ms

### `realtime`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7280ms): Context lacks hotel booking confirmation number, seafood reservation confirmation, and specific activity details.
- `opencode` — FAIL (10249ms): The context contains weather and hotel search results but is truncated ("0 of 1698 chars retained"), losing the hotel booking confirmation number, seafood reservation confirmation number, and any sugg
- `codex` — FAIL (8287ms): The context only preserves weather and a truncated hotel search, and it does not contain the required hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, or a complete list of sugg
- `gemini` — FAIL (15404ms): The context lacks the specific hotel booking (LCH-2026-05-23-A7Q3) and seafood reservation (RES-J-A4K7) confirmation numbers required by the criterion, and the most recent turn content was truncated t

**Probe 2** (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12889ms): The context contains the Saturday weather forecast for Busan as "sunny" with a high of "24°C" from both the tool result and assistant response in the recap section.
- `opencode` — PASS (8990ms): Context contains the Saturday Busan forecast in both the tool_result ("Saturday: sunny, high 24°C low 18°C") and the discoveries recap ("Saturday will be sunny with a high of 24°C"), satisfying both "
- `codex` — PASS (11310ms): The context explicitly states Saturday in Busan was sunny with a high of 24°C, which satisfies the required Saturday weather detail.
- `gemini` — PASS (12642ms): The context explicitly captures the Saturday weather forecast of sunny with a high of 24°C in both the tool results and discoveries sections of the conversation recap.

### `anthropic-native`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (11634ms): Missing hotel booking confirmation number LCH-2026-05-23-A7Q3
- `opencode` — FAIL (14082ms): Hotel booking confirmation number LCH-2026-05-23-A7Q3 is absent from the truncated context (only 1131 of 2904 chars retained, missing the earlier hotel booking exchange); seafood confirmation RES-J-A4
- `codex` — FAIL (7129ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several activities like Haeundae Beach, Jagalchi Market, Gwangalli, Dongbaek Park, and Centum City, but it does not contain the
- `gemini` — FAIL (9991ms): The context contains the seafood reservation (RES-J-A4K7) and suggested activities but completely lacks the hotel booking confirmation number LCH-2026-05-23-A7Q3.

**Probe 2** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (33799ms): The context mentions Saturday is sunny but lacks the temperature detail (24°C) required by the pass criterion.
- `opencode` — FAIL (17907ms): Context mentions "Saturday is sunny" in assistant thinking but the original forecast with the specific temperature "24°C" was lost in the truncation — the 1131/2904 char retained context dropped turns
- `codex` — FAIL (9790ms): The context only preserves that Saturday is sunny, but it omits the originally checked forecast detail of 24°C high, so it is insufficient to meet the criterion.
- `gemini` — FAIL (18659ms): The context mentions that Saturday is sunny but omitted the required 24°C temperature high specified in the pass criterion.

### `off`

**Probe 1** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7263ms): Missing hotel booking confirmation number LCH-2026-05-23-A7Q3
- `opencode` — FAIL (11298ms): Hotel booking confirmation number LCH-2026-05-23-A7Q3 is absent from the retained context (truncated — early conversation containing the hotel booking was lost); only the seafood reservation RES-J-A4K
- `codex` — FAIL (11543ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several activities like Haeundae Beach, Jagalchi Market, Gwangalli, Dongbaek Park, Centum City, and BIFF Square, but it does no
- `gemini` — FAIL (13009ms): The context is missing the mandatory hotel booking confirmation number LCH-2026-05-23-A7Q3 due to truncation.

**Probe 2** (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (24045ms): The context mentions "Saturday is sunny" but lacks the temperature "24°C" required by the criterion.
- `opencode` — FAIL (16972ms): "Saturday is sunny" 기반으로는 (assistant가 생각함) 기온 "24°C"는 나오지 않으며, 이는 컨텍스트 창에서 사라졌습니다.
- `codex` — FAIL (8429ms): The context preserves that Saturday was sunny but drops the required temperature 24°C, so it lacks enough faithful detail to meet the criterion.
- `gemini` — FAIL (15256ms): The temperature 24°C is missing from the context, which only mentions that Saturday is sunny without specifying the temperature originally established in turns 3 and 4.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
