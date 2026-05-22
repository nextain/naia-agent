# Mini-bench (R7 / judge ensemble) — F-LME-s-6222b6eb — 2026-05-21

- **Fixture**: F-LME-s-6222b6eb (longmemeval-s-single-session-assistant)
- **Strategies**: pi, hermes, reactive, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `pi` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 |
| `hermes` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6690ms): Context lacks any information about atmospheric correction algorithms or SIAC_GEE tool, requiring abstention.
- `opencode` — FAIL (8875ms): The context contains no information about atmospheric correction algorithms (6S, MAJA, Sen2Cor) or the SIAC_GEE tool, so an agent cannot provide the required answer that the 6S algorithm is implemente
- `codex` — FAIL (6602ms): The retained context contains no mention of atmospheric correction, 6S, MAJA, Sen2Cor, or SIAC_GEE, so it does not supply the fact that SIAC_GEE implements 6S.
- `gemini` — FAIL (14607ms): The context lacks any information regarding SIAC_GEE or atmospheric correction algorithms, focusing instead on spirituality and workplace diversity.

### `hermes`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6541ms): Context lacks any information about SIAC_GEE or atmospheric correction algorithms, so an honest agent would abstain.
- `opencode` — FAIL (5981ms): The context contains no information about atmospheric correction methods, 6S, MAJA, Sen2Cor, or SIAC_GEE — it only includes conversations about spirituality/meditation and workplace diversity.
- `codex` — FAIL (7415ms): The provided context contains no information about atmospheric correction methods, SIAC_GEE, or which algorithm it implements, so the required fact about 6S is missing.
- `gemini` — FAIL (15700ms): The context contains discussions about spirituality and workplace diversity but lacks any information regarding atmospheric correction methods or the SIAC_GEE tool.

### `reactive`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (15216ms): Context lacks any mention of atmospheric correction algorithms, SIAC_GEE tool, or related technical details, forcing abstention.
- `opencode` — PASS (6510ms): The context contains no information about atmospheric correction methods, 6S, MAJA, Sen2Cor, or SIAC_GEE, so an honest agent would be unable to answer and would abstain.
- `codex` — FAIL (8233ms): The provided context contains no information about atmospheric correction methods or SIAC_GEE, so it does not support concluding that SIAC_GEE implements the 6S algorithm.
- `gemini` — FAIL (21608ms): The context contains no information about atmospheric correction, the 6S algorithm, or the SIAC_GEE tool, which are necessary to provide the required answer.

### `off`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (5417ms): Context contains no information about atmospheric correction algorithms or SIAC_GEE tool.
- `opencode` — FAIL (8686ms): The retained context contains only conversations about spirituality/meditation and workplace diversity; all information about atmospheric correction methods (6S, MAJA, Sen2Cor, SIAC_GEE) was lost to t
- `codex` — FAIL (8291ms): The provided context contains no information about atmospheric correction methods or SIAC_GEE, so it does not support identifying that SIAC_GEE implements the 6S algorithm.
- `gemini` — FAIL (15617ms): The context contains no mention of atmospheric correction algorithms or the SIAC_GEE tool, focusing instead on spirituality and workplace diversity.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.