# Mini-bench (R7 / judge ensemble) — F-LME-s-505af2f5 — 2026-05-21

- **Fixture**: F-LME-s-505af2f5 (longmemeval-s-single-session-preference)
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
| `pi` | 0.000 (n=1) | n/a | n/a | **YES (recap empty)** | 3.0 | 60005 | 0/0 |
| `hermes` | 0.000 (n=1) | n/a | n/a | **YES (recap empty)** | 3.0 | 362 | 0/0 |
| `reactive` | 0.000 (n=1) | n/a | n/a | no | 3.0 | 3 | 0/0 |
| `off` | 0.000 (n=1) | n/a | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (408ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (18948ms): The retained context contains only metadata-standards and high-protein-lunch conversations; the user's coffee creamer preferences (almond milk, vanilla extract, honey, sugar reduction, cost savings) a
- `codex` — FAIL (10887ms): The context contains no information about any existing almond milk, vanilla extract, and honey creamer recipe, sugar-reduction or cost-saving goals, or preferences about avoiding commercial or expensi
- `gemini` — FAIL (13232ms): The context contains information about metadata standards and high-protein lunch ideas but lacks any mention of the user's existing coffee creamer recipe or their preferences regarding sugar and cost.

### `hermes`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (123ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (13692ms): The context contains no mention of coffee creamer, almond milk, vanilla extract, honey, sugar reduction goals, or money-saving preferences, so the required preference answer cannot be derived from it.
- `codex` — FAIL (5398ms): The context contains no information about coffee creamer, almond milk, vanilla extract, honey, reducing sugar, saving money, or any preference against commercial or expensive high-sugar options, so th
- `gemini` — FAIL (12558ms): The context contains information about metadata standards and high-protein diet plans but lacks any mention of the user's coffee creamer recipe or preferences regarding almond milk, vanilla, honey, su

### `reactive`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (140ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (5243ms): The context contains no mention of almond milk, vanilla extract, honey, creamer recipes, reducing sugar intake, or saving money — it only has unrelated conversations about metadata standards, fitness/
- `codex` — FAIL (7289ms): The context contains no information about any existing almond milk, vanilla extract, and honey creamer recipe or preferences about reducing sugar, saving money, or avoiding commercial creamers, so the
- `gemini` — FAIL (25246ms): The context contains information about metadata standards and high-protein diet plans but lacks any mention of the user's existing coffee creamer recipe or their specific preferences for sugar reducti

### `off`

**Probe 1** [recap-only] (after turn 554) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (35766ms): Context lacks any information about coffee creamers, recipes, or user preferences for sugar reduction/cost savings, requiring abstention.
- `opencode` — PASS (9087ms): The context contains no information about coffee creamers, almond milk, vanilla extract, honey, sugar reduction, or saving money, so an honest agent would abstain from answering.
- `codex` — FAIL (12335ms): The context contains no information about coffee creamer, an existing almond milk/vanilla/honey recipe, or preferences about reducing sugar, saving money, or avoiding commercial/high-sugar/expensive o
- `gemini` — FAIL (24825ms): the context lacks any mention of the user's existing creamer recipe involving almond milk, vanilla, and honey, as well as their specific goals for reducing sugar and saving money.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.