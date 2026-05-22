# Mini-bench (R7 / judge ensemble) — F-LME-s-2a1811e2 — 2026-05-22

- **Fixture**: F-LME-s-2a1811e2 (longmemeval-s-temporal-reasoning)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 3406 | 60343/113 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 40234 | 60108/310 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 17975 | 991/734 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (10102ms): Context lacks any mention of Holi, St. Mary's Church, or related dates, so an honest agent would abstain.
- `opencode` — FAIL (20243ms): The context contains only conversations about horse herd behavior and OSHA forklift certification copywriting; it provides no dates or mentions of the Hindu festival of Holi or a Sunday mass at St. Ma
- `codex` — FAIL (6800ms): The provided context contains no information about Holi, St. Mary's Church, or any dates needed to compute the number of days between them.
- `gemini` — FAIL (17380ms): The context contains information about horse social hierarchies and forklift certification but lacks any mention of the Hindu festival of Holi or the Sunday mass at St. Mary's Church required to answe

### `hermes`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (10502ms): Context contains no information about Holi, St. Mary's Church, or any dates relevant to the question.
- `opencode` — FAIL (14189ms): The context contains no mention of Holi, St. Mary's Church, any dates, or any temporal information related to the question — it is entirely about horses/ponies and OSHA forklift certification.
- `codex` — FAIL (6638ms): The context shown contains no information about Holi, St. Mary's Church, or any dates for those events, so it does not support deriving the required 21-day interval.
- `gemini` — FAIL (14426ms): The context contains information about horse social behavior and forklift certification but lacks any mention of the Hindu festival of Holi or St. Mary's Church, providing no basis for calculating the

### `reactive`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (15216ms): Context lacks any mention of Holi, St. Mary's Church, or dates related to these events, so an honest agent would abstain.
- `opencode` — FAIL (11614ms): The context contains no mention of the Hindu festival of Holi, St. Mary's Church, or any dates related to them — the information needed to compute the number of days is entirely absent.
- `codex` — FAIL (5902ms): The context contains no dates or references to Holi or the Sunday mass at St. Mary's Church, so it does not supply the information needed to derive 21 days.
- `gemini` — FAIL (12975ms): The context contains information about horse social hierarchies and forklift certification but entirely lacks any mention of the Hindu festival of Holi or St. Mary's Church required to calculate the t

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7971ms): Context contains no information about Holi, St. Mary's Church, or any related dates or events.
- `opencode` — PASS (9206ms): The context contains no mention of Holi, St. Mary's Church, or any dates related to either event, so an honest agent would abstain from answering.
- `codex` — FAIL (5659ms): The provided context contains no dates or mentions of Holi or St. Mary's Church, so it does not supply the information needed to determine the elapsed days.
- `gemini` — FAIL (18977ms): The context contains discussions on equine social structures and forklift certification but completely lacks any reference to Holi, St. Mary's Church, or the dates needed to determine the number of da

### `off`

**Probe 1** [tail-trivial] (after turn 525) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6818ms): Context lacks any mention of Holi, St. Mary's Church, or their dates, so an honest agent would abstain.
- `opencode` — PASS (12127ms): The context contains no mention of Holi, St. Mary's Church, or any dates, so an honest agent would abstain rather than fabricate an answer.
- `codex` — FAIL (6219ms): The provided context contains no information about Holi, St. Mary's Church, or any dates, so it does not supply the facts needed to derive the required 21-day interval.
- `gemini` — FAIL (15869ms): The context contains information about horse social structures and forklift certification but lacks any mention of Holi, St. Mary's Church, or the dates required to calculate the elapsed time.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.