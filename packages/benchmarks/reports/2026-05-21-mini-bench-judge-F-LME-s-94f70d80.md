# Mini-bench (R7 / judge ensemble) — F-LME-s-94f70d80 — 2026-05-21

- **Fixture**: F-LME-s-94f70d80 (longmemeval-s-single-session-user)
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

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 3.0 | 60026 | 0/0 |
| `hermes` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 3.0 | 60032 | 0/0 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (348ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (3675ms): The context contains no mention of assembling an IKEA bookshelf or any duration related to it, so an honest agent would abstain rather than answer '4 hours'.
- `codex` — FAIL (6677ms): The context only contains discussion about a Coursera Design Thinking Specialization and provides no information about any IKEA bookshelf assembly time, so it cannot support the required answer of 4 h
- `gemini` — FAIL (31830ms): The context contains only information about a Coursera specialization and lacks any mention of an IKEA bookshelf or the 4-hour assembly time.

### `hermes`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (209ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (7094ms): The context contains no mention of an IKEA bookshelf or any assembly time, so an honest agent would have to say "unknown" — the context lacks the information needed to produce the required answer of "
- `codex` — FAIL (6067ms): The context only discusses a Coursera Design Thinking specialization and contains no information about any IKEA bookshelf assembly time, so it cannot support the required answer of 4 hours.
- `gemini` — FAIL (23079ms): The provided context is entirely about a Coursera specialization and contains no information regarding an IKEA bookshelf or an assembly time of 4 hours.

### `reactive`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5319ms): Context contains no information about IKEA bookshelf assembly time, forcing abstention.
- `opencode` — PASS (4201ms): Context lacks any mention of IKEA bookshelf assembly time, so an honest agent would abstain.
- `codex` — FAIL (9252ms): The context only contains a discussion about a Coursera design thinking specialization and never mentions any IKEA bookshelf or the time taken to assemble it, so 4 hours cannot be recovered.
- `gemini` — FAIL (14994ms): the context provides information about a Coursera specialization but lacks any mention of the IKEA bookshelf or the assembly duration of 4 hours.

### `off`

**Probe 1** [tail-trivial] (after turn 559) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (4933ms): Context contains no information about IKEA bookshelf assembly time, so an agent would need to abstain rather than provide '4 hours'.
- `opencode` — FAIL (4057ms): The context contains no mention of an IKEA bookshelf or any assembly time; an honest agent would abstain.
- `codex` — FAIL (6224ms): The context contains no information about assembling an IKEA bookshelf or any duration, so it cannot support the required answer of 4 hours.
- `gemini` — FAIL (14120ms): The context contains information about a Coursera Design Thinking course but lacks any mention of an IKEA bookshelf or the 4-hour assembly time required by the pass criterion.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.