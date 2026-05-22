# Mini-bench (R7 / judge ensemble) — F-LME-s-778164c6 — 2026-05-21

- **Fixture**: F-LME-s-778164c6 (longmemeval-s-single-session-assistant)
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
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8668ms): Context lacks any information about Caribbean dishes, Jamaican food, snapper, or mango salsa, so an honest agent would abstain.
- `opencode` — FAIL (8935ms): The context contains zero information about Caribbean dishes, Jamaican recipes, snapper, or any food-related conversation — it only covers Nintendo Switch Joy-Con libraries and banana fiber clothing, 
- `codex` — FAIL (14195ms): The retained context contains no mention of Caribbean food, Jamaican dishes, snapper, fruit, or the dish name Grilled Snapper with Mango Salsa, so the required answer is unsupported.
- `gemini` — FAIL (13214ms): The context contains information about Nintendo Switch controllers and banana fiber clothing, but lacks any mention of Caribbean dishes, Jamaican snapper, or fruit-based recipes.

### `hermes`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6443ms): Context lacks any information about Jamaican dishes, snapper, or fruit-based recipes, requiring abstention.
- `opencode` — FAIL (20935ms): The truncated context contains only discussions about Joy-Con controllers and banana fiber clothing with no mention of any Caribbean dishes or Jamaican snapper recipes, so the required answer "Grilled
- `codex` — FAIL (8388ms): The retained context contains no prior discussion of Caribbean food or any Jamaican snapper dish with fruit, so it does not supply the needed fact Grilled Snapper with Mango Salsa.
- `gemini` — FAIL (17310ms): The context contains information about Nintendo Switch controllers and banana fiber clothing but lacks any mention of Caribbean dishes, Jamaican snapper, or the specific dish Grilled Snapper with Mang

### `reactive`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7755ms): Context lacks any mention of Caribbean dishes, Jamaican food, snapper, or mango salsa, so an honest agent would abstain.
- `opencode` — FAIL (10758ms): The context contains no mention of any Caribbean dishes, Jamaican recipes, snapper, or fruit-based dishes — it only discusses Joy-Con controllers, Nintendo Switch, and banana fiber clothing.
- `codex` — FAIL (7966ms): The retained context contains unrelated Joy-Con and clothing discussion and does not include any prior recommendation about a Jamaican snapper dish with fruit, so the required dish name cannot be reco
- `gemini` — FAIL (17354ms): The context contains details about Nintendo Switch controllers and a clothing business but lacks any mention of Caribbean food, snapper, or mango salsa.

### `off`

**Probe 1** [tail-trivial] (after turn 592) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (17893ms): Context lacks any mention of Caribbean dishes, Jamaican food, snapper, or mango salsa, so an honest agent would abstain.
- `opencode` — FAIL (8451ms): The context contains no mention of Caribbean dishes, Jamaican dishes, snapper, or any fruit-based fish dish — only Nintendo Joy-Con protocol discussions and banana fiber clothing business content, so 
- `codex` — FAIL (8720ms): The retained context contains no prior discussion of Caribbean food or any Jamaican snapper dish with fruit, so it does not supply the fact needed to answer Grilled Snapper with Mango Salsa.
- `gemini` — FAIL (18321ms): The provided context contains information about Nintendo Switch controllers and a clothing business but lacks any mention of Caribbean dishes, Jamaican snapper, or mango salsa.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.