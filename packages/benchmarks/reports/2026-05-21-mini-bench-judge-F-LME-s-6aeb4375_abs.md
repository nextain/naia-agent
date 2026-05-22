# Mini-bench (R7 / judge ensemble) — F-LME-s-6aeb4375_abs — 2026-05-21

- **Fixture**: F-LME-s-6aeb4375_abs (longmemeval-s-knowledge-update)
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
| `pi` | n/a | n/a | 0.000 (n=1) | **YES (recap empty)** | 3.0 | 60025 | 0/0 |
| `hermes` | n/a | n/a | 0.000 (n=1) | **YES (recap empty)** | 3.0 | 505 | 0/0 |
| `reactive` | n/a | n/a | 0.000 (n=1) | no | 4.0 | 2 | 0/0 |
| `off` | n/a | n/a | 0.000 (n=1) | no | 3.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (448ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (17852ms): The context shows no mention of Korean or Italian restaurants; the required answer references Korean restaurant visits which are absent from the visible context, so an agent could not produce the crit
- `codex` — FAIL (12648ms): The shown context does not provide any restaurant-tracking information at all, so it lacks the specific fact that you mentioned trying Korean restaurants but not Italian restaurants.
- `gemini` — FAIL (18591ms): The context contains no mention of Korean or Italian restaurants, making it impossible for an agent to provide the specific required answer contrasting the two.

### `hermes`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (126ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — FAIL (12647ms): The context contains no mention of either Korean or Italian restaurants (it covers Napa Valley, a wedding, and improv training), so an agent cannot produce the required answer that references Korean r
- `codex` — FAIL (9548ms): The context does not provide any count of Italian restaurants and also does not include the supporting fact that you mentioned trying Korean restaurants instead, so the required specific abstention an
- `gemini` — FAIL (54117ms): The context is missing any mention of Korean restaurants, which is required to satisfy the specific contrastive abstention mandated by the criterion.

### `reactive`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8266ms): Context contains no information about Italian restaurants or dining experiences in the user's city, requiring abstention.
- `opencode` — PASS (4646ms): Context contains no mention of Italian restaurants being tried (only references to Korean restaurants and general restaurant mentions unrelated to the user's city), so an honest agent would abstain an
- `codex` — FAIL (7643ms): The provided context does not mention how many Italian restaurants were tried or even the referenced Korean restaurants, so it lacks the specific facts needed for the required abstention answer.
- `gemini` — FAIL (24366ms): The context contains no mention of the user trying Korean restaurants, which is a required component of the specific abstention answer defined in the pass criterion.

### `off`

**Probe 1** [unclassified] (after turn 567) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (239ms): GLM HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}
- `opencode` — PASS (5793ms): The context contains no mention of Italian restaurants at all — it covers Napa Valley transportation, a cousin's wedding, and improv leadership training — so an honest agent would correctly state the 
- `codex` — FAIL (7107ms): The context does not contain the needed memory that you tried Korean restaurants but not Italian restaurants, so it lacks the specific facts required for the target abstaining answer.
- `gemini` — FAIL (24277ms): The context does not contain the mention of Korean restaurants required by the pass criterion to provide the specific contrastive reason for abstaining from the question about Italian restaurants.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.