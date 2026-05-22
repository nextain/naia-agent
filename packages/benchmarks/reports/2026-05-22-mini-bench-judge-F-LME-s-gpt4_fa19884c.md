# Mini-bench (R7 / judge ensemble) — F-LME-s-gpt4_fa19884c — 2026-05-22

- **Fixture**: F-LME-s-gpt4_fa19884c (longmemeval-s-temporal-reasoning)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 38063 | 52636/1888 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 23941 | 51827/360 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 10271 | 799/489 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (5222ms): Context contains zero information about keyboards, playing music, or bluegrass bands, making it impossible to determine the time gap between these events.
- `opencode` — PASS (6906ms): The context contains no information about playing songs on a keyboard or discovering a bluegrass band, so an honest agent would abstain rather than fabricate an answer.
- `codex` — FAIL (5927ms): The retained context only shows unrelated cat litter and airline discussion and contains no dates or events about starting to play along on an old keyboard or discovering a bluegrass band, so the requ
- `gemini` — FAIL (38620ms): The context is missing the narrative about the keyboard and the bluegrass band, containing only unrelated discussions about cat litter boxes and flight bookings.

### `hermes`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7656ms): Context lacks any information about keyboard playing or bluegrass band discovery, requiring abstention.
- `opencode` — FAIL (21044ms): The context contains no mention of playing songs on an old keyboard or discovering a bluegrass band, nor any dates from which the 6-day interval could be computed.
- `codex` — FAIL (6810ms): The provided context snippet contains no information about starting to play along on an old keyboard, discovering a bluegrass band, or the dates needed to compute the number of days.
- `gemini` — FAIL (12298ms): The context contains information about cat litter boxes and airline travel but lacks any mention of a keyboard or a bluegrass band needed to answer the question.

### `reactive`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8702ms): Context lacks any mention of keyboards, playing music, bluegrass bands, or timeline events, so an honest agent would abstain.
- `opencode` — FAIL (19730ms): The context contains no mention of playing keyboard to favorite songs, discovering a bluegrass band, or any dates/times that would allow computing the number of days between those two events — the rel
- `codex` — FAIL (5637ms): The provided context only shows unrelated travel and pet-litter conversations and does not include either the keyboard-start date or the bluegrass-band discovery date needed to compute the elapsed day
- `gemini` — FAIL (15641ms): The context contains information about cat litter boxes and airline flights but is completely missing the narrative events regarding the keyboard and the bluegrass band required to answer the question

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6937ms): Context contains no information about keyboard playing or bluegrass band discovery, so an honest agent would abstain.
- `opencode` — FAIL (13699ms): The retained context contains only conversations about litter boxes and flight bookings; no mention of playing a keyboard or discovering a bluegrass band, so the temporal-reasoning answer cannot be de
- `codex` — FAIL (5405ms): The provided context snippet contains no dates or events about starting to play favorite songs on an old keyboard or discovering a bluegrass band, so the required 6-day interval cannot be determined.
- `gemini` — FAIL (20368ms): The context provides information regarding cat litter boxes and flight recommendations but lacks any mention of the keyboard or bluegrass band events required to calculate the six-day duration specifi

### `off`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (21276ms): Context lacks any mention of keyboard playing or bluegrass band discovery, requiring abstention.
- `opencode` — FAIL (18271ms): The context contains only conversations about litter boxes and airline recommendations; it includes no mention of playing a keyboard or discovering a bluegrass band, so the agent could not compute the
- `codex` — FAIL (8445ms): The context only shows unrelated cat and airline conversations and contains no information about when the user started playing along on an old keyboard or when they discovered a bluegrass band, so the
- `gemini` — FAIL (17978ms): The provided context contains information about cat litter boxes and airline bookings but completely lacks the story about the keyboard and the bluegrass band, making it impossible to calculate the re

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.