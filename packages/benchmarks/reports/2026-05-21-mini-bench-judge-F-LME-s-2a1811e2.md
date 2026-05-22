# Mini-bench (R7 / judge ensemble) — F-LME-s-2a1811e2 — 2026-05-21

- **Fixture**: F-LME-s-2a1811e2 (longmemeval-s-temporal-reasoning)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 48590 | 58576/2036 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 49511 | 58345/1660 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9112ms): Context lacks any mention of Holi, St. Mary's Church, or related dates, so an honest agent would abstain.
- `opencode` — FAIL (4583ms): The context contains no mention of the Hindu festival of Holi or a Sunday mass at St. Mary's Church, providing zero temporal data from which an agent could compute the number of days between these two
- `codex` — FAIL (8809ms): The context contains no information about Holi, St. Mary's Church, or any dates needed to compute the interval, so it cannot support the required answer of 21 days.
- `gemini` — FAIL (11853ms): The context contains information about horse social hierarchy and forklift certification but lacks any mention of the Hindu festival of Holi or St. Mary's Church required to determine the time differe

### `hermes`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9384ms): Context lacks any mention of Holi, St. Mary's Church, or related dates, so an honest agent would abstain.
- `opencode` — FAIL (6601ms): The context contains no mention of Holi, St. Mary's Church, or any dates, so an honest agent would abstain — but the criterion requires the specific answer "21 days," meaning the probe expects the con
- `codex` — FAIL (6200ms): The provided context contains no dates or mentions of Holi or the Sunday mass at St. Mary's Church, so it does not supply the information needed to derive 21 days.
- `gemini` — FAIL (16880ms): The context only contains discussions about horse social hierarchies and OSHA forklift certification, with no mention of Holi or St. Mary's Church to support the required answer.

### `reactive`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6537ms): Context lacks any mention of Holi, St. Mary's Church, or related dates, so an honest agent would abstain.
- `opencode` — FAIL (4164ms): The context contains only conversations about horse herd behavior and OSHA forklift certification copywriting — no mention of Holi, St. Mary's Church, or any dates that would allow computing a number 
- `codex` — FAIL (7756ms): The context contains no mention of Holi, St. Mary's Church, the Sunday mass, or any dates needed to compute the number of days between them.
- `gemini` — FAIL (24860ms): The context contains information about horse social hierarchies and forklift certification but lacks any mention of Holi, St. Mary's Church, or the dates required to calculate the interval.

### `off`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6951ms): Context contains no information about Holi, St. Mary's Church, or any temporal relationship between them.
- `opencode` — FAIL (3987ms): The context contains no mention of Holi, St. Mary's Church, any dates, or any temporal information that would allow calculating days between two events.
- `codex` — FAIL (7185ms): The provided context contains no information about Holi, St. Mary's Church, or any relevant dates, so it does not support deriving the required 21-day interval.
- `gemini` — FAIL (14102ms): The provided context contains information about horse social hierarchies and OSHA certification but completely lacks the dates or mention of the Hindu festival of Holi and the Sunday mass at St. Mary'

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.