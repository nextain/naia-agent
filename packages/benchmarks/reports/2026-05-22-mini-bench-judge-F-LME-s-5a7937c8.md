# Mini-bench (R7 / judge ensemble) — F-LME-s-5a7937c8 — 2026-05-22

- **Fixture**: F-LME-s-5a7937c8 (longmemeval-s-multi-session)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 5067 | 52749/268 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 38641 | 52547/5934 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 25791 | 867/662 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6626ms): Context lacks any mention of December, faith-related activities, or personal schedule information, so an honest agent would abstain.
- `opencode` — FAIL (21236ms): The context contains no information about faith-related activities in December — the visible conversation covers San Francisco trip planning and SVG atom animation, with no mention of faith activities
- `codex` — FAIL (8270ms): The provided context contains no information about December or faith-related activities, so an agent limited to this context could not correctly answer 3 days.
- `gemini` — FAIL (13599ms): The provided context contains no information about December activities or faith-related events, which is necessary to provide the required answer of 3 days.

### `hermes`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (25305ms): Context lacks any mention of December, faith-related activities, or personal schedule information, so an honest agent would abstain.
- `opencode` — FAIL (15085ms): The context contains no mention of faith-related activities in December or any count of days, so the required answer of "3 days" cannot be derived from the available information.
- `codex` — FAIL (5409ms): The provided context contains no information about December or any faith-related activities, so it cannot support the required answer of 3 days.
- `gemini` — FAIL (11450ms): The context contains information about San Francisco trip planning and SVG animations but lacks any mention of faith-related activities or December dates.

### `reactive`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (4645ms): Context contains no information about December or faith-related activities, so an agent would need to abstain rather than provide a specific answer.
- `opencode` — FAIL (13624ms): The context contains no information about faith-related activities in December; it only discusses San Francisco trip planning and SVG atom animation.
- `codex` — FAIL (6999ms): The provided context contains no information about December faith-related activities or any day count, so it does not support answering 3 days.
- `gemini` — FAIL (16422ms): The context lacks any mention of faith-related activities or December events, focusing instead on San Francisco neighborhoods and SVG animations.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9497ms): Context lacks any mention of December, faith-related activities, or personal schedule information, so an honest agent would abstain.
- `opencode` — FAIL (17446ms): The context contains only conversations about San Francisco neighborhoods and SVG animation, with no mention of faith-related activities or December, so the required answer "3 days" cannot be derived 
- `codex` — FAIL (6212ms): The provided context contains no information about December or faith-related activities, so an agent limited to this context could not truthfully answer 3 days.
- `gemini` — FAIL (18419ms): The context contains information about San Francisco neighborhoods and SVG animations but lacks any mention of faith-related activities or December to support the required answer of 3 days.

### `off`

**Probe 1** [tail-trivial] (after turn 461) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6841ms): Context lacks any mention of December, faith-related activities, or personal schedule information, so an honest agent would abstain.
- `opencode` — FAIL (7331ms): The context contains no information about faith-related activities in December or any count of days spent on such activities.
- `codex` — FAIL (6744ms): The provided context contains no information about December or faith-related activities, so an agent could not answer that the user spent 3 days on them.
- `gemini` — FAIL (13866ms): The context contains information about San Francisco neighborhoods and SVG animations, but lacks any mention of faith-related activities or the month of December.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.