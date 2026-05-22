# Mini-bench (R7 / judge ensemble) — F-LME-s-bc149d6b — 2026-05-21

- **Fixture**: F-LME-s-bc149d6b (longmemeval-s-multi-session)
- **Strategies**: pi, hermes, reactive, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | 0.000 (n=1) | n/a | n/a | **YES (recap empty)** | 3.0 | 60024 | 0/0 |
| `hermes` | 0.000 (n=1) | n/a | n/a | **YES (recap empty)** | 3.0 | 60013 | 0/0 |
| `reactive` | 0.000 (n=1) | n/a | n/a | no | 3.0 | 2 | 0/0 |
| `off` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (432ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (6791ms): The context contains no information about any feed purchase, its weight, or any transaction history; the question refers to facts entirely absent from the provided conversation.
- `codex` — FAIL (7006ms): The provided context only discusses camping and Yellowstone and contains no information about any feed purchases or their weights, so it cannot support the required answer of 70 pounds.
- `gemini` — FAIL (40406ms): The context contains no mention of purchasing feed or its weight, as the previous 45 sessions have been truncated without a summary of past events.

### `hermes`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (118ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (10186ms): The context contains no information about feed purchases or their weight; an agent cannot derive '70 pounds' from camping recipes, stargazing recommendations, or campsite amenities discussed.
- `codex` — FAIL (5921ms): The retained context only contains camping and Yellowstone discussion and provides no information about any feed purchases, dates, or weights needed to answer 70 pounds.
- `gemini` — FAIL (10120ms): The context contains only information about camping, hiking, recipes, and campsites, with no mention of feed purchases or their weights.

### `reactive`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (216ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (15301ms): The context contains only camping recipe/stargazing/campsite conversations with no mention of feed purchases or any weight quantities; the required "70 pounds" information is absent from the truncated
- `codex` — FAIL (8856ms): The provided context only contains camping and stargazing discussion and gives no information about any feed purchase or its weight in the past two months.
- `gemini` — FAIL (13514ms): The context contains information about camping trips and recipes but completely lacks any mention of feed purchases or their weights.

### `off`

**Probe 1** [recap-only] (after turn 513) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (11378ms): Context lacks any information about feed purchases or weights, so an honest agent would abstain.
- `opencode` — FAIL (11272ms): The context contains only camping recipes, stargazing recommendations, and campsite suggestions with no mention of any feed purchase or its weight, so the required answer of 70 pounds cannot be derive
- `codex` — FAIL (5610ms): The provided context only discusses camping and stargazing and contains no information about any feed purchases or their weights, so it does not support answering 70 pounds.
- `gemini` — FAIL (23335ms): The context contains only discussion about camping recipes and travel recommendations, with no mention of feed purchases or weights necessary to provide the required answer of 70 pounds.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.