# Mini-bench (R7 / judge ensemble) — F-LME-s-bc8a6e93_abs — 2026-05-22

- **Fixture**: F-LME-s-bc8a6e93_abs (longmemeval-s-single-session-user)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 1 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 6206 | 51843/448 |
| `hermes` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 15260 | 51883/964 |
| `reactive` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 32612 | 748/973 |
| `off` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6312ms): Context contains no mention of baking for an uncle's birthday party, so an honest agent would correctly abstain.
- `opencode` — PASS (17259ms): The context does not contain any information about baking for an uncle's birthday party, so an honest agent would abstain or state the user didn't mention it; the context does reference baking for a n
- `codex` — FAIL (6713ms): The provided context contains no mention of baking, no uncle birthday party, and no niece birthday party, so it does not supply the specific contrast required by the pass criterion.
- `gemini` — FAIL (16251ms): The context contains no mention of baking or a niece's birthday party, making it impossible for the agent to provide the specific contrastive answer required by the criterion.

### `hermes`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8152ms): Context contains no information about baking for an uncle's birthday party, so an honest agent would correctly state the information wasn't mentioned.
- `opencode` — FAIL (29066ms): The retained context contains no mention of baking for either a niece's or uncle's birthday party, so the agent cannot produce the required answer referencing the niece's birthday baking as a contrast
- `codex` — FAIL (6208ms): The provided context contains no mention of baking anything, nor any reference to a niece's or uncle's birthday party, so it does not support the required specific answer.
- `gemini` — FAIL (12270ms): The context contains no mention of baking or a niece's birthday party, so an agent could not provide the required response correcting the uncle's party to a niece's.

### `reactive`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9149ms): Context mentions baking for niece's birthday but not uncle's, so an honest agent would correctly abstain from answering about uncle's baking.
- `opencode` — PASS (20672ms): The context contains no mention of baking anything for an uncle's birthday party, so an honest agent would correctly state that this information was not provided, supporting the required abstention re
- `codex` — FAIL (7454ms): The provided context does not contain any mention of baking, your uncle, or your niece’s birthday party, so it cannot support the required specific answer about niece-not-uncle.
- `gemini` — FAIL (16057ms): The context contains no mention of baking or birthdays for either a niece or an uncle, making it impossible to provide the specific correction required by the pass criterion.

### `naia+llm`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (17597ms): Context only mentions baking for a niece's birthday party, not an uncle's, so an honest agent would correctly abstain from answering about the uncle's party.
- `opencode` — FAIL (20373ms): The context contains no mention of baking anything for a niece's or uncle's birthday party, so an agent would have no basis to provide the required nuanced distinction.
- `codex` — FAIL (7470ms): The shown context contains no mention of baking, a niece, or an uncle's birthday party, so it does not support the required answer about niece-versus-uncle information.
- `gemini` — FAIL (18434ms): The context contains no information about baking or birthday parties, making it impossible for an agent to provide the required correction regarding the niece's birthday party.

### `off`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (36957ms): Context contains no information about baking for an uncle's birthday party, requiring abstention.
- `opencode` — PASS (24960ms): The context contains no mention of baking anything for an uncle's birthday party, so an honest agent would correctly abstain and note the absence of that information.
- `codex` — FAIL (7264ms): The provided context contains no mention of baking, no uncle’s birthday party, and no niece’s birthday party, so it lacks the specific fact the criterion requires the agent to state.
- `gemini` — FAIL (15215ms): The context contains no mention of baking, birthdays, nieces, or uncles, so an agent cannot provide the required contrast between the niece's party and the uncle's.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.