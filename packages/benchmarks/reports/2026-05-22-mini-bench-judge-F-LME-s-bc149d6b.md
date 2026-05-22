# Mini-bench (R7 / judge ensemble) — F-LME-s-bc149d6b — 2026-05-22

- **Fixture**: F-LME-s-bc149d6b (longmemeval-s-multi-session)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 12771 | 53440/543 |
| `hermes` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 39185 | 52983/565 |
| `reactive` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 2 | 0/0 |
| `naia+llm` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 22099 | 706/538 |
| `off` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8799ms): Context lacks any mention of feed purchases, weights, or related topics, so an honest agent would abstain.
- `opencode` — PASS (8639ms): The context contains no information about any feed purchase or its weight, so an honest agent would abstain from answering rather than fabricating "70 pounds."
- `codex` — FAIL (6230ms): The provided context only discusses camping trips and campsite recommendations and contains no information about any feed purchases or weights, so it cannot support the required answer of 70 pounds.
- `gemini` — FAIL (23474ms): The context contains no information about purchasing feed or its weight, focusing instead on a hiking trip to Yellowstone and camping recommendations.

### `hermes`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5718ms): Context contains no information about feed purchases or weights, so an honest agent would abstain.
- `opencode` — PASS (18763ms): The context contains no mention of any feed purchase or weight, so an honest agent would abstain rather than fabricate an answer.
- `codex` — FAIL (6534ms): The provided context contains no information about any feed purchases or their weights in the past two months, so it cannot support the required answer of 70 pounds.
- `gemini` — FAIL (16059ms): The provided context contains information regarding camping and hiking trips but lacks any mention of feed purchases or the specific weight of 70 pounds required by the criterion.

### `reactive`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (26132ms): Context lacks any information about feed purchases, so an honest agent would abstain.
- `opencode` — FAIL (32100ms): The context contains only camping-related conversations (recipes, stargazing, campsites) with no mention of any feed purchase or weight, so the "70 pounds" answer cannot be derived from it.
- `codex` — FAIL (12520ms): The provided context only discusses camping and Yellowstone and contains no information about any feed purchases or their weights in the past two months, so 70 pounds cannot be derived.
- `gemini` — FAIL (10573ms): The context contains only information about camping trips, recipes, and stargazing locations, but lacks any mention of feed purchases or their weights.

### `naia+llm`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5373ms): Context lacks any information about feed purchases, so an honest agent would abstain.
- `opencode` — FAIL (21268ms): The context contains only camping recipes, stargazing recommendations, and campsite suggestions — no mention of any feed purchase or its weight, so the required answer of 70 pounds cannot be derived.
- `codex` — FAIL (9707ms): The provided context only discusses camping and Yellowstone trips and contains no information about any feed purchases or their weight, so it cannot support the required answer of 70 pounds.
- `gemini` — FAIL (24030ms): The context contains information about camping and Yellowstone but lacks any mention of feed purchases or weights, making it impossible to answer '70 pounds'.

### `off`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (44928ms): Context lacks any information about feed purchases, so an honest agent would abstain.
- `opencode` — FAIL (29283ms): Context contains no mention of any feed purchase or a weight of 70 pounds; the conversations are entirely about camping, recipes, and stargazing, providing zero information to answer the question.
- `codex` — FAIL (5937ms): The provided context only discusses camping trips and campsite recommendations and contains no information about any feed purchase or its weight in the past two months.
- `gemini` — FAIL (31742ms): The context contains information about camping and hiking adventures but lacks any mention of feed purchases or the specific weight of 70 pounds required to satisfy the criterion.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.