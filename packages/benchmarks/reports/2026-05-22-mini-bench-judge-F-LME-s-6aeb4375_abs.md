# Mini-bench (R7 / judge ensemble) — F-LME-s-6aeb4375_abs — 2026-05-22

- **Fixture**: F-LME-s-6aeb4375_abs (longmemeval-s-knowledge-update)
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
| `pi` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 8145 | 56265/642 |
| `hermes` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 40138 | 56152/311 |
| `reactive` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 19530 | 770/414 |
| `off` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (40721ms): Context contains no information about Italian restaurants or dining experiences in the user's city, necessitating abstention.
- `opencode` — PASS (36739ms): The context contains no mention of Italian restaurants (or Korean restaurants) anywhere in the retained tail, so an honest agent would correctly abstain and state the information is insufficient.
- `codex` — FAIL (8486ms): The retained context does not provide any count of Italian restaurants and does not even mention trying Korean restaurants, so it lacks the specific facts needed for the required abstention answer.
- `gemini` — FAIL (28969ms): The context contains no mention of the user trying Korean restaurants, which is a required factual component for the specific contrastive abstention mandated by the pass criterion.

### `hermes`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (37097ms): Context contains no information about Italian restaurants, so an honest agent would correctly state the information is insufficient.
- `opencode` — FAIL (32627ms): The truncated context contains no mention of Italian or Korean restaurants, so the agent cannot produce the required answer referencing Korean restaurants the user tried; it can only give a generic "I
- `codex` — FAIL (8075ms): The context shown does not mention how many Italian restaurants the user tried and also does not include the expected supporting fact that the user mentioned trying Korean restaurants instead.
- `gemini` — FAIL (19846ms): The context lacks any mention of Korean restaurants, making it impossible for an agent to provide the required contrastive answer specified in the pass criterion.

### `reactive`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (10011ms): Context lacks any mention of Italian restaurants or dining experiences, so the required response about insufficient information cannot be justified.
- `opencode` — FAIL (37336ms): The visible context contains no mention of Korean or Italian restaurants, so an agent cannot produce the criterion's required answer distinguishing the two; truncation lost the earlier Korean-restaura
- `codex` — FAIL (8122ms): The retained context contains no information about how many Italian restaurants you tried and does not even include the referenced Korean-restaurant detail needed to justify the required abstention wo
- `gemini` — FAIL (51846ms): The context contains no information about Korean or Italian restaurants, preventing the agent from fulfilling the criterion's requirement to mention previously discussed Korean restaurants.

### `naia+llm`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (26071ms): Context lacks any mention of Italian restaurants or the user's dining experiences, requiring abstention.
- `opencode` — FAIL (19766ms): The visible context contains no mention of Italian or Korean restaurants at all, so the required answer referencing Korean restaurants cannot be derived from the retained context (the Korean restauran
- `codex` — FAIL (7799ms): The context does not contain any information about restaurants tried in the user's city, nor the required detail that the user mentioned Korean restaurants but not Italian restaurants.
- `gemini` — FAIL (33050ms): The context lacks any mention of Korean restaurants, which the pass criterion explicitly requires the agent to reference as part of its contrastive abstention response.

### `off`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8989ms): Context contains no information about Italian restaurants or dining experiences in the user's city, supporting abstention.
- `opencode` — FAIL (23256ms): The retained context contains no mention of either Italian or Korean restaurants; the agent would have to say "I don't have that information" without referencing Korean restaurants as the pass criteri
- `codex` — FAIL (7178ms): The visible context contains no information about restaurants in the user's city and does not mention trying Korean restaurants, so it does not support the required abstaining answer with that specifi
- `gemini` — FAIL (15674ms): The context contains no mention of the user's history with Korean or Italian restaurants, making it impossible for an agent to provide the specific required abstention reason.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.