# Mini-bench (R7 / judge ensemble) — F-LME-s-bc8a6e93_abs — 2026-05-21

- **Fixture**: F-LME-s-bc8a6e93_abs (longmemeval-s-single-session-user)
- **Strategies**: pi, hermes, reactive, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 1 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | n/a | 0.000 (n=1) | **YES (recap empty)** | 3.0 | 655 | 0/0 |
| `hermes` | n/a | n/a | 0.000 (n=1) | **YES (recap empty)** | 3.0 | 890 | 0/0 |
| `reactive` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 3 | 0/0 |
| `off` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (137ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (6340ms): Context contains no mention of baking for any niece's or uncle's birthday party, so an honest agent would simply say it doesn't know rather than producing the specific niece-vs-uncle distinction the c
- `codex` — FAIL (8687ms): The retained context contains no mention of baking, any birthday party, a niece, or an uncle, so it does not provide the specific contrast required by the pass criterion.
- `gemini` — FAIL (14130ms): The context lacks the necessary information about the user baking for their niece's birthday party, which is required by the pass criterion to provide a correct contrast to the question about the uncl

### `hermes`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (131ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — PASS (3842ms): Context contains no mention of baking for an uncle's birthday party, so an honest agent would correctly state the user did not provide this information, supporting the abstention-style criterion.
- `codex` — FAIL (9683ms): The provided context does not contain any mention of baking for a niece's birthday party or an uncle's birthday party, so it lacks the specific fact needed for the required abstaining/paraphrased answ
- `gemini` — FAIL (18124ms): The context contains no information about baking or a niece's birthday party, making it impossible for an agent to provide the specific comparison required by the pass criterion.

### `reactive`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7610ms): The context contains no information about baking for an uncle's birthday party.
- `opencode` — PASS (4865ms): Context contains no mention of baking anything for an uncle's birthday party (the context discusses Gower sustainability, Rain100L/H datasets, and web portals), so an honest agent would abstain and in
- `codex` — FAIL (7004ms): The provided context does not mention baking anything for either an uncle or a niece, so it lacks the specific fact needed to answer that you mentioned your niece's birthday party but not your uncle's
- `gemini` — FAIL (14459ms): The context contains no mention of baking, a niece's birthday party, or an uncle's birthday, making it impossible for an agent to provide the specific corrective information required by the pass crite

### `off`

**Probe 1** [unclassified] (after turn 540) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6688ms): Context contains no information about baking for an uncle's birthday party, so an honest agent would correctly state this information wasn't provided.
- `opencode` — PASS (5334ms): The context contains no mention of baking for an uncle's birthday party (it discusses Gower sustainability, Rain100 datasets, and web portals), so an honest agent would correctly abstain and note the 
- `codex` — FAIL (8845ms): The provided context contains no mention of baking, any birthday party, or a niece versus uncle distinction, so it does not support the required specific paraphrase.
- `gemini` — FAIL (17980ms): The context contains no mention of baking or a niece's birthday party, making it impossible for the agent to distinguish between them as required by the pass criterion.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.