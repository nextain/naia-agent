# Mini-bench (R7 / judge ensemble) — F-LME-s-505af2f5 — 2026-05-22

- **Fixture**: F-LME-s-505af2f5 (longmemeval-s-single-session-preference)
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
| `pi` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 35338 | 54639/2185 |
| `hermes` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 38733 | 54752/4223 |
| `reactive` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 6 | 0/0 |
| `naia+llm` | 0.000 (n=1) | n/a | n/a | no | 3.0 | 27260 | 850/719 |
| `off` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (11838ms): Context lacks any information about coffee creamers, recipes, or user preferences for sugar reduction/cost savings, requiring abstention.
- `opencode` — FAIL (16795ms): The context contains only conversations about metadata standards and high-protein lunch ideas; there is no mention of coffee creamers, almond milk, vanilla extract, honey, sugar-reduction goals, or mo
- `codex` — FAIL (9905ms): The context contains no information about coffee creamer preferences, almond milk/vanilla/honey, or goals about reducing sugar and saving money, so the required recommendation preference cannot be inf
- `gemini` — FAIL (24728ms): The context contains information regarding metadata standards and high-protein fitness lunches but lacks any mention of the user's existing coffee creamer recipe, almond milk, honey, or specific dieta

### `hermes`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (53308ms): Context lacks any information about coffee creamers, the user's existing recipe, or their preferences for sugar reduction and cost savings, making abstention necessary.
- `opencode` — FAIL (18120ms): The context contains no mention of the user's existing almond milk, vanilla extract, and honey creamer recipe, nor any stated goals about reducing sugar intake or saving money — these facts are entire
- `codex` — FAIL (5697ms): The context contains no information about any existing almond milk, vanilla extract, and honey creamer recipe, sugar-reduction or money-saving goals, or preferences about commercial creamers, so the r
- `gemini` — FAIL (26101ms): The context contains no information about the user's existing coffee creamer recipe using almond milk, vanilla, and honey, nor does it mention their goals of reducing sugar intake or saving money.

### `reactive`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6579ms): Context lacks any information about coffee creamers, almond milk, vanilla extract, honey, sugar reduction, or cost-saving, so an honest agent would abstain.
- `opencode` — FAIL (30665ms): The context contains no mention of coffee creamer, almond milk, vanilla extract, honey, sugar reduction goals, or money-saving preferences — an agent cannot produce the required preference-specific an
- `codex` — FAIL (12330ms): The context contains no information about any coffee creamer recipe, almond milk/vanilla/honey preferences, or goals about reducing sugar and saving money, so the required preference answer cannot be 
- `gemini` — FAIL (41309ms): The context contains no information about the user's existing coffee creamer recipe, preferences for almond milk or honey, nor any mention of goals regarding sugar reduction or cost-saving.

### `naia+llm`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (8672ms): Context lacks any information about coffee creamers, recipes, or the user's preferences for almond milk, vanilla extract, honey, sugar reduction, or cost savings, forcing abstention.
- `opencode` — FAIL (20538ms): The context contains no mention of coffee creamer, almond milk, vanilla extract, honey, sugar reduction goals, or money-saving goals — it discusses metadata standards and fitness/lunch ideas, so there
- `codex` — FAIL (6218ms): The context contains only metadata and fitness-diet discussion and provides no information about any existing almond milk, vanilla extract, and honey creamer recipe, sugar-reduction goal, budget goal,
- `gemini` — **INFRA** (127153ms): gemini timed out after 90000ms

### `off`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (30572ms): Context lacks any information about coffee creamers, existing recipes, or user preferences for sugar reduction/cost savings, requiring abstention.
- `opencode` — FAIL (19113ms): The context contains no mention of coffee creamer, almond milk, vanilla extract, honey, or any user preferences about reducing sugar intake or saving money, so the required preference inference cannot
- `codex` — FAIL (7164ms): The context contains only unrelated metadata and fitness/lunch discussion and provides no information about any almond milk, vanilla extract, honey creamer recipe, sugar-reduction goal, budget prefere
- `gemini` — FAIL (25091ms): The context contains information about metadata standards and fitness/protein but completely lacks the user's previous coffee creamer recipe or preferences required by the pass criterion.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.