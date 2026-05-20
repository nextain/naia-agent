# Mini-bench (judge ensemble) — F001-customer-support — 2026-05-20

- **Fixture**: F001-customer-support (customer-support)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `realtime` | 1.000 | 2.0 | 2 | 0.000 | 0.000 |
| `anthropic-native` | 0.000 | 2.0 | 2 | 0.000 | 1.000 |
| `off` | 0.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 22) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (4857ms): GLM reply unparseable: 
- `opencode` — PASS (22032ms): The assistant correctly references all four identifiers — Visa ending 4291, ticket TCK-99812, order #A-7421, and the 5–7 business day refund window — without inventing any details.
- `codex` — FAIL (11458ms): The response includes Visa ending 4291, ticket TCK-99812, and order #A-7421 but does not clearly provide a summary with all four required identifiers.
- `gemini` — PASS (11500ms): The response correctly identifies and summarizes the four identifiers: Visa ending 4291, ticket TCK-99812, order #A-7421, and the 5-7 business days timeframe.

### `realtime`

**Probe 1** (after turn 22) — ensemble: ✅ PASS (2/4 valid)

- `glm` — **INFRA** (4895ms): GLM reply unparseable: 
- `opencode` — PASS (21350ms): All four identifiers (Visa 4291, TCK-99812, A-7421, 10% discount) appear in the compacted transcript and match the original conversation facts without invention.
- `codex` — PASS (16233ms): The response includes all four key identifiers visible in context, including Visa ending 4291, ticket TCK-99812, order #A-7421, and the 5-7 business day refund window, without adding unsupported detai
- `gemini` — **INFRA** (97456ms): gemini timed out after 60000ms

### `anthropic-native`

**Probe 1** (after turn 22) — ensemble: ❌ FAIL (2/4 valid)

- `glm` — **INFRA** (5617ms): GLM reply unparseable: 
- `opencode` — FAIL (8979ms): The response reproduces the full conversation transcript instead of providing a summary that references the four identifiers (order #A-7421, jane.doe@example.com, Visa ending 4291, ticket TCK-99812).
- `codex` — PASS (7752ms): It correctly includes the four identifiers order #A-7421, jane.doe@example.com, Visa ending 4291, and ticket TCK-99812 without adding new ones.
- `gemini` — **INFRA** (105638ms): gemini timed out after 60000ms

### `off`

**Probe 1** (after turn 22) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — **INFRA** (8337ms): GLM reply unparseable: 
- `opencode` — FAIL (26356ms): The response reproduces the raw conversation instead of providing a summary of the key facts as requested, so there is no "assistant summary" to evaluate against the criterion.
- `codex` — PASS (7463ms): The response includes all four identifiers from the visible context only: order #A-7421, jane.doe@example.com, Visa ending 4291, and ticket TCK-99812.
- `gemini` — FAIL (41732ms): The response is a conversation transcript rather than a summary and does not fulfill the request to summarize the four identifiers.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
