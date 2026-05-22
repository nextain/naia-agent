# Mini-bench (R7 / judge ensemble) — F-LME-s-778164c6 — 2026-05-22

- **Fixture**: F-LME-s-778164c6 (longmemeval-s-single-session-assistant)
- **Strategies**: pi, hermes, reactive, naia+llm, off
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

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 47859 | 58277/3318 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 39703 | 58098/310 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 14840 | 824/645 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6688ms): Context lacks any information about Caribbean dishes, Jamaican food, snapper, or mango salsa, so an honest agent would abstain.
- `opencode` — FAIL (5627ms): The context contains no mention of Caribbean dishes, Jamaican food, snapper, mango salsa, or any prior conversation about food recommendations — it only contains discussions about Joy-Con controllers 
- `codex` — FAIL (8879ms): The retained context contains no prior discussion of Caribbean dishes, Jamaican food, snapper, or any fruit-based dish name, so it does not supply the fact needed to answer Grilled Snapper with Mango 
- `gemini` — FAIL (14529ms): The context contains discussions about Nintendo Switch controllers and clothing business value propositions, but completely lacks any information regarding Caribbean dishes, snapper, or the specific f

### `hermes`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5902ms): Context lacks any information about Caribbean dishes, Jamaican cuisine, snapper, or fruit-based recipes, so an honest agent would abstain.
- `opencode` — FAIL (15137ms): The retained context contains only conversations about Nintendo Switch Joy-Con controllers and banana fiber clothing — there is no mention of any Caribbean dishes, Jamaican food, snapper, or mango sal
- `codex` — FAIL (5378ms): The retained context contains only discussion about Joy-Con/joycontrol and a clothing business, with no mention of any Caribbean or Jamaican dish, snapper, fruit, or the specific recommendation needed
- `gemini` — FAIL (15517ms): The context contains information about Nintendo Switch protocols and sustainable clothing but entirely lacks any mention of Jamaican dishes, snapper, or the specific recommendation required by the pas

### `reactive`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (10023ms): Context lacks any information about Jamaican dishes, snapper, or fruit-based recipes, so an honest agent would abstain from answering.
- `opencode` — FAIL (15756ms): The context contains only conversations about Joy-Con controllers and banana fiber clothing—there is no mention of Caribbean dishes, snapper, or any Jamaican recipe, so the agent cannot produce the re
- `codex` — FAIL (5890ms): The retained context contains no prior discussion of Caribbean dishes, Jamaican food, snapper, or any fruit-based recommendation, so the required answer cannot be recovered.
- `gemini` — FAIL (13628ms): The context contains information about Nintendo Switch protocols and a blended clothing business but lacks any mention of Caribbean dishes, snapper, or the specific recommendation of Grilled Snapper w

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (22261ms): Context lacks any mention of Jamaican dishes, snapper, or fruit-based recommendations, so an honest agent would abstain.
- `opencode` — FAIL (14369ms): The context contains no mention of Caribbean dishes, snapper, mango salsa, or any prior conversation about food recommendations — only unrelated topics about Joy-Con controllers and banana fiber cloth
- `codex` — FAIL (5494ms): The retained context contains no mention of Caribbean food, snapper, fruit, or the dish name, so it does not supply the needed fact Grilled Snapper with Mango Salsa.
- `gemini` — FAIL (11218ms): The context contains information about Nintendo Switch protocols and blended clothing businesses but lacks any mention of Caribbean dishes, snapper, or fruit.

### `off`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (7184ms): Context contains no information about Caribbean dishes, Jamaican food, snapper, or mango salsa.
- `opencode` — FAIL (5764ms): The context contains no mention of any Caribbean dishes, Jamaican recipes, or fish/snapper recommendations — it covers Joy-Con controllers, Nintendo Switch, and banana fiber clothing, providing zero i
- `codex` — FAIL (6251ms): The retained context contains no prior discussion of Caribbean or Jamaican dishes, snapper, or any fruit-based recommendation, so it does not supply the fact needed to answer Grilled Snapper with Mang
- `gemini` — FAIL (13332ms): The context contains information about Nintendo Switch controllers and a blended clothing business, but completely lacks any mention of Jamaican dishes, snapper, or fruit-based recipes required to pro

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.