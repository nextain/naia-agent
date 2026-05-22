# Mini-bench (R7 / judge ensemble) — F-LME-s-gpt4_fa19884c — 2026-05-21

- **Fixture**: F-LME-s-gpt4_fa19884c (longmemeval-s-temporal-reasoning)
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
| `pi` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 60023 | 0/0 |
| `hermes` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 60021 | 0/0 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6008ms): Context contains no information about keyboards, music, or bluegrass bands, so an honest agent would abstain.
- `opencode` — FAIL (12751ms): The retained context contains only conversations about litter boxes and airline recommendations; there is no mention of playing songs on a keyboard or discovering a bluegrass band, so the temporal rea
- `codex` — FAIL (9564ms): The provided context contains no information about when the user started playing along on an old keyboard or when they discovered a bluegrass band, so the required 6-day interval cannot be derived.
- `gemini` — FAIL (20250ms): The context consists of discussions about cat litter boxes and airline recommendations and contains no mention of the keyboard playing or the bluegrass band discovery.

### `hermes`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (4152ms): Context contains no information about keyboards, music practice, or bluegrass bands, so an honest agent would abstain.
- `opencode` — PASS (10726ms): The context contains no information about playing songs on a keyboard or discovering a bluegrass band (the retained 14K chars only cover litter box and airline discussions), so an honest agent would a
- `codex` — FAIL (10304ms): The retained context only shows unrelated pet and airline conversations and does not include either event date needed to compute the elapsed days.
- `gemini` — FAIL (14933ms): The context contains information regarding cat litter boxes and airline flight recommendations but lacks any mention of a keyboard or a bluegrass band, making it impossible to calculate the number of 

### `reactive`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (15977ms): Context contains no information about keyboards, playing music, bluegrass bands, or any timeline between events.
- `opencode` — FAIL (5575ms): The context contains only conversations about litter boxes and airline recommendations; there is no mention of playing a keyboard or discovering a bluegrass band, so the required temporal information 
- `codex` — FAIL (6056ms): The provided context contains no information about when the user started playing along to favorite songs on an old keyboard or when they discovered a bluegrass band, so the required 6-day interval can
- `gemini` — FAIL (17353ms): The context contains information about cat litter boxes and airline flight recommendations but lacks any mention of keyboard playing or the discovery of a bluegrass band.

### `off`

**Probe 1** [tail-trivial] (after turn 553) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (30064ms): Context lacks any mention of keyboard playing or bluegrass band discovery, so no temporal data exists to calculate days between events.
- `opencode` — FAIL (12321ms): The context contains only conversations about litter boxes and airline recommendations with no mention of playing keyboard, favorite songs, or discovering a bluegrass band, so the required temporal ca
- `codex` — FAIL (6609ms): The provided context contains no information about starting to play along on an old keyboard or discovering a bluegrass band, so it does not support deriving the required 6-day interval.
- `gemini` — FAIL (14514ms): The context contains only information about litter boxes and airline flight recommendations, with no mention of keyboards, songs, or bluegrass bands.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.