# Mini-bench (R7 / judge ensemble) — F-LME-s-94f70d80 — 2026-05-22

- **Fixture**: F-LME-s-94f70d80 (longmemeval-s-single-session-user)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 3.0 | 19572 | 54050/276 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 77139 | 53820/311 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 6 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 16055 | 1027/836 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 3.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (7020ms): Context contains no information about IKEA bookshelf assembly time, so an honest agent would abstain.
- `opencode` — FAIL (9178ms): The context contains no mention of assembling an IKEA bookshelf or any duration related to such an activity; the context only discusses a Coursera Design Thinking Specialization.
- `codex` — FAIL (6117ms): The context contains no mention of any IKEA bookshelf or assembly duration, so it does not supply the required fact that it took 4 hours.
- `gemini` — **INFRA** (138567ms): gemini timed out after 90000ms

### `hermes`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7854ms): Context contains no information about IKEA bookshelf assembly time.
- `opencode` — FAIL (14349ms): The context contains only a conversation about Coursera's Design Thinking Specialization with no mention of an IKEA bookshelf or any assembly time, so the required "4 hours" answer cannot be produced 
- `codex` — FAIL (7465ms): The context contains no information about assembling an IKEA bookshelf or any duration, so it does not support the required answer of 4 hours.
- `gemini` — FAIL (16374ms): The context only contains information about a Coursera Design Thinking Specialization and lacks any mention of an IKEA bookshelf or the time taken to assemble one.

### `reactive`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9052ms): Context contains no information about IKEA bookshelf assembly time, so an honest agent would abstain.
- `opencode` — FAIL (14191ms): The context contains no mention of an IKEA bookshelf or any furniture assembly duration, so an agent cannot produce the required answer of "4 hours".
- `codex` — FAIL (6618ms): The provided context contains only discussion about a Coursera Design Thinking Specialization and does not mention any IKEA bookshelf or the time taken to assemble it, so 4 hours cannot be derived.
- `gemini` — FAIL (13586ms): The context contains no mention of an IKEA bookshelf or the four-hour assembly time required by the pass criterion, focusing instead on a Coursera Design Thinking Specialization.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5287ms): Context contains no information about IKEA bookshelf assembly time, so an honest agent would abstain.
- `opencode` — FAIL (8911ms): Context contains no mention of IKEA bookshelves or assembly time; the conversation is about a Coursera Design Thinking Specialization, so an honest agent would abstain rather than answer "4 hours."
- `codex` — FAIL (7457ms): The context contains no information about assembling an IKEA bookshelf or any duration, so it does not support the required answer of 4 hours.
- `gemini` — FAIL (25794ms): The context contains no information about an IKEA bookshelf or the assembly duration, making it impossible to provide the required answer of 4 hours.

### `off`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (7108ms): Context contains no information about IKEA bookshelf assembly time, so an agent would need to abstain rather than provide '4 hours'.
- `opencode` — PASS (14578ms): Context contains no mention of IKEA, a bookshelf, or any assembly time, so an honest agent would correctly abstain rather than fabricate "4 hours."
- `codex` — FAIL (7110ms): The provided context contains no information about assembling an IKEA bookshelf or any duration, so the required answer 4 hours is unsupported.
- `gemini` — **INFRA** (137056ms): gemini timed out after 90000ms

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.