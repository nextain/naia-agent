# Mini-bench (judge ensemble) — F-EN-TH-01-tool-heavy — 2026-05-21

- **Fixture**: F-EN-TH-01-tool-heavy (tool-heavy)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 1.000 | 0.500 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 1.000 | 0.500 |
| `realtime` | 1.000 | 4.0 | 0 | 1.000 | 1.000 |
| `anthropic-native` | 0.000 | 4.0 | 0 | 1.000 | 1.000 |
| `off` | 0.000 | 4.0 | 0 | 1.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (40914ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities including Haeundae beach, Jagalchi market, Gwangalli beach, and Dongbaek Park.
- `opencode` — PASS (7020ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and activities including Haeundae beach, Jagalchi Seafood Market, Gwangalli beach, Dongbaek Park, Centum City, 
- `codex` — PASS (9980ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae Beach, Jagalchi 
- `gemini` — PASS (11004ms): The context contains the hotel confirmation LCH-2026-05-23-A7Q3, the seafood reservation RES-J-A4K7, and several suggested activities including Haeundae beach and Jagalchi market.

### `reactive-vercel`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (20574ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood confirmation RES-J-A4K7, and multiple activities including Haeundae beach, Jagalchi market, Gwangalli beach, Dongbaik Park, Centum City
- `opencode` — PASS (9111ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi Market, Gwangalli beach, Dongbaek Park, Centum C
- `codex` — PASS (6954ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae Beach, Jagalchi 
- `gemini` — PASS (18434ms): The context explicitly contains the hotel confirmation LCH-2026-05-23-A7Q3, the seafood reservation RES-J-A4K7, and multiple activities like the Haeundae beach walk and Jagalchi Market.

### `realtime`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (59899ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple activities including Haeundae beach, Jagalchi market, Gwangalli beach, Dongbaek Park,
- `opencode` — PASS (7893ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and activities including Haeundae beach walk, Jagalchi Seafood Market, Gwangalli beach, Dongbaek P
- `codex` — PASS (10524ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae beach, Jagalchi 
- `gemini` — PASS (11733ms): The context explicitly provides the hotel confirmation (LCH-2026-05-23-A7Q3), the seafood reservation confirmation (RES-J-A4K7), and multiple specific activities like Haeundae beach and Jagalchi Marke

### `anthropic-native`

**Probe 1** (after turn 14) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (9052ms): Missing hotel booking confirmation number LCH-2026-05-23-A7Q3
- `opencode` — FAIL (10874ms): The hotel booking confirmation number LCH-2026-05-23-A7Q3 is absent — the context was truncated at 1080 of 2835 chars and lost the earlier hotel booking exchange, so only (b) the seafood reservation R
- `codex` — FAIL (9063ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several activities, but it does not contain any hotel booking details or the required confirmation LCH-2026-05-23-A7Q3, so the 
- `gemini` — FAIL (11027ms): The context is missing the hotel booking confirmation number LCH-2026-05-23-A7Q3 required by the pass criterion.

### `off`

**Probe 1** (after turn 14) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7889ms): Context is missing hotel booking confirmation number LCH-2026-05-23-A7Q3
- `opencode` — FAIL (7121ms): Hotel booking confirmation LCH-2026-05-23-A7Q3 is absent from the retained context (truncated at 1080 of 2835 chars — the hotel booking likely fell in the lost portion); only RES-J-A4K7 and activities
- `codex` — FAIL (10441ms): The context includes the seafood reservation confirmation RES-J-A4K7 and several activities like Haeundae Beach, Jagalchi Market, Gwangalli, Dongbaek Park, Centum City, and BIFF Square, but it does no
- `gemini` — FAIL (10791ms): The context is missing the hotel booking confirmation number LCH-2026-05-23-A7Q3 required by the pass criterion.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
