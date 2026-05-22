# Mini-bench (R7 / judge ensemble) — F-LME-s-5a7937c8 — 2026-05-21

- **Fixture**: F-LME-s-5a7937c8 (longmemeval-s-multi-session)
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
| `pi` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 632 | 0/0 |
| `hermes` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 3.0 | 344 | 0/0 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 3.0 | 2 | 0/0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5613ms): Context lacks any mention of December, faith-related activities, or personal schedule information, so an honest agent would abstain.
- `opencode` — FAIL (9812ms): The context contains only conversations about San Francisco trip planning and SVG atom animation; no mention of faith-related activities or December scheduling exists anywhere in the retained context.
- `codex` — FAIL (7446ms): The provided context contains no information about December faith-related activities or any count of days, so it cannot support the required answer of 3 days.
- `gemini` — FAIL (13444ms): The provided context contains information about San Francisco neighborhoods and SVG animations but completely lacks any data regarding faith-related activities or December schedules.

### `hermes`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (118ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (5784ms): The retained context contains no information about faith-related activities in December; the visible tail discusses San Francisco neighborhoods and SVG animation, so the required "3 days" answer is no
- `codex` — FAIL (6871ms): The provided context contains no information about December or any faith-related activities, so it does not supply the fact needed to answer 3 days.
- `gemini` — FAIL (12063ms): The context contains information about San Francisco neighborhoods and SVG animations but lacks any mention of faith-related activities or the month of December.

### `reactive`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (231ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (10686ms): The context contains no information about faith-related activities in December; it only covers San Francisco travel planning and SVG atom animation, so the "3 days" answer cannot be derived from the a
- `codex` — FAIL (17864ms): The provided context contains no information about December faith-related activities or any day count, so it does not support answering 3 days.
- `gemini` — FAIL (23110ms): The context contains information about San Francisco neighborhoods and SVG animations but lacks any mention of faith-related activities or a count of days in December.

### `off`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (4419ms): Context contains no information about December or faith-related activities, so an agent would need to abstain rather than provide a specific answer.
- `opencode` — FAIL (9792ms): The context contains only conversations about San Francisco trip planning and SVG atom animation; there is no mention of faith-related activities in December or any count of days spent on them.
- `codex` — FAIL (6250ms): The provided context contains no information about December faith-related activities or any count of days, so it does not support answering 3 days.
- `gemini` — FAIL (12694ms): The context contains information about San Francisco neighborhoods and SVG animations but lacks any mention of December or faith-related activities needed to answer the question.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.