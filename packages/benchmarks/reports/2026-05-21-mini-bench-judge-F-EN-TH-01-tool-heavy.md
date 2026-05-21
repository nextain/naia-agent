# Mini-bench (R7 / judge ensemble) — F-EN-TH-01-tool-heavy — 2026-05-21

- **Fixture**: F-EN-TH-01-tool-heavy (tool-heavy)
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
| `reactive` | 0.000 (n=1) | 0.000 (n=1) | n/a | no | 3.5 |
| `reactive-vercel` | 0.000 (n=1) | 0.000 (n=1) | n/a | no | 3.5 |
| `realtime` | 0.000 (n=1) | 0.000 (n=1) | n/a | no | 4.0 |
| `off` | 0.000 (n=1) | 0.000 (n=1) | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (10732ms): Context provides seafood reservation confirmation RES-J-A4K7 and multiple activities (Haeundae beach, Jagalchi market, Gwangalli, etc.) but lacks hotel booking confirmation number.
- `opencode` — FAIL (4464ms): Context is truncated and missing the hotel booking confirmation number LCH-2026-05-23-A7Q3, which was likely in the lost 1974 characters of the conversation.
- `codex` — FAIL (6644ms): The context provides the seafood reservation confirmation RES-J-A4K7 and several activities like Haeundae Beach, Jagalchi Market, Gwangalli Beach, Dongbaek Park, Centum City, and BIFF Square, but it d
- `gemini` — **INFRA** (104572ms): gemini timed out after 90000ms

**Probe 2** [recap-only] (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (9621ms): Context mentions Saturday is sunny but lacks the required temperature detail (24°C) established in turns 3-4.
- `opencode` — FAIL (11647ms): The context mentions "sunny" for Saturday in the assistant's thinking block, but the specific temperature "24°C" is absent from the retained context — the truncation appears to have dropped the origin
- `codex` — FAIL (13333ms): The context only states that Saturday is sunny and never includes the 24°C high, so it does not supply enough information to answer the forecast as required.
- `gemini` — FAIL (18007ms): The context identifies that Saturday is sunny but lacks the temperature of 24°C specifically required by the pass criterion for a successful answer.

### `reactive-vercel`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (8022ms): Context lacks hotel booking confirmation number LCH-2026-05-23-A7Q3 (or equivalent) required for complete trip summary.
- `opencode` — FAIL (4356ms): Context is truncated and missing the hotel booking confirmation number LCH-2026-05-23-A7Q3, so an agent cannot produce a complete summary satisfying all three criteria.
- `codex` — FAIL (13024ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several activities like Haeundae, Jagalchi, Gwangalli, Dongbaek Park, Centum City, and BIFF Square, but it does not include any
- `gemini` — FAIL (67440ms): The context lacks the hotel booking confirmation number LCH-2026-05-23-A7Q3 required by the pass criterion.

**Probe 2** [recap-only] (after turn 19) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (17015ms): Context only mentions 'Saturday is sunny' but lacks the required temperature detail '24°C' in the recap range.
- `opencode` — FAIL (10471ms): Context mentions "Saturday is sunny" but the specific temperature "24°C" is absent — the original weather forecast detail from turns 3-4 was lost during compaction/truncation, so an agent cannot repor
- `codex` — FAIL (6495ms): The context only preserves that Saturday was sunny, but it omits the required 24°C high, so it is insufficient to answer the forecast unambiguously.
- `gemini` — **INFRA** (127976ms): gemini timed out after 90000ms

### `realtime`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (10529ms): Context lacks hotel booking confirmation number required for complete trip summary.
- `opencode` — FAIL (9616ms): Hotel booking confirmation LCH-2026-05-23-A7Q3 is absent from the truncated context (only 1131 of 3072 chars retained), so an agent cannot include it despite the seafood confirmation and activities be
- `codex` — FAIL (8519ms): The context provides the seafood reservation confirmation RES-J-A4K7 and several activities like Haeundae Beach, Jagalchi Market, Gwangalli Beach, Dongbaek Park, Centum City, and BIFF Square, but it d
- `gemini` — FAIL (11129ms): The hotel booking confirmation number LCH-2026-05-23-A7Q3 is entirely missing from the provided context.

**Probe 2** [recap-only] (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (12187ms): Context only mentions 'Saturday is sunny' but lacks the required temperature detail (24°C) established in turns 3-4.
- `opencode` — FAIL (6869ms): The context does not contain the original Saturday weather forecast (sunny, 24°C) for Busan — only truncated conversation about activities and a reservation, with no weather data preserved.
- `codex` — FAIL (12228ms): The context only says Saturday is sunny but never includes the required 24°C forecast, so it is insufficient to answer the question to the pass criterion.
- `gemini` — FAIL (48022ms): While the context mentions that Saturday is sunny, it lacks any mention of the 24°C temperature required by the pass criterion.

### `off`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7865ms): The context lacks hotel booking confirmation number and details about the hotel booking, which is required by the criterion.
- `opencode` — FAIL (11141ms): The hotel booking confirmation number LCH-2026-05-23-A7Q3 is missing — the context was truncated (only 1131 of 2904 chars retained), and the hotel booking details fell in the lost portion; only the se
- `codex` — FAIL (7568ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several suggested activities, but it does not include any hotel booking confirmation such as LCH-2026-05-23-A7Q3, so the comple
- `gemini` — FAIL (15220ms): The hotel booking confirmation number LCH-2026-05-23-A7Q3 is missing from the provided context due to truncation.

**Probe 2** [recap-only] (after turn 19) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (8608ms): Context mentions 'Saturday is sunny' but lacks the required temperature detail '24°C' or '24'.
- `opencode` — FAIL (15051ms): The context mentions "Saturday is sunny" but does not contain the specific temperature "24°C" — the detail was lost in the truncated portion of context, so an agent cannot provide the full forecast.
- `codex` — FAIL (5906ms): The context only preserves that Saturday was sunny and suitable for the beach, but it does not include the required 24°C temperature from the original forecast.
- `gemini` — FAIL (24743ms): The context mentions that Saturday is sunny but lacks the specific temperature of 24°C required by the pass criterion.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.