# Mini-bench (R7 / judge ensemble) — F-LME-s-852ce960 — 2026-05-21

- **Fixture**: F-LME-s-852ce960 (longmemeval-s-knowledge-update)
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

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `pi` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 |
| `hermes` | n/a | 0.000 (n=1) | n/a | **YES (recap empty)** | 4.0 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (4959ms): Context contains no information about mortgage pre-approval amounts from Wells Fargo, requiring abstention.
- `opencode` — FAIL (19559ms): The context contains no mention of Wells Fargo, a mortgage pre-approval, or any dollar amount related to a home loan — the relevant information was lost in the truncation from 210,103 to 15,949 chars.
- `codex` — FAIL (12066ms): The context contains no information about any Wells Fargo mortgage pre-approval amount, so it does not support the required answer of $400,000.
- `gemini` — FAIL (21293ms): The context contains discussions about moving services and film history but omits any mention of a Wells Fargo mortgage or the $400,000 pre-approval amount required to satisfy the pass criterion.

### `hermes`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5212ms): Context lacks any mortgage details, Wells Fargo references, or financial data, so an honest agent would abstain.
- `opencode` — FAIL (11431ms): The context contains no mention of Wells Fargo, a mortgage, or any pre-approval amount; the information needed to produce '$400,000' is entirely absent.
- `codex` — FAIL (8615ms): The retained context contains unrelated discussion about moving details and Frank Lloyd films, but no mention of any Wells Fargo mortgage or a pre-approval amount such as $400,000.
- `gemini` — FAIL (16292ms): The context contains information about moving logistics and filmmaker Frank Lloyd but lacks any mention of a mortgage pre-approval amount or Wells Fargo.

### `reactive`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6789ms): Context lacks any mortgage or financial information, so an honest agent would abstain from answering the pre-approval amount question.
- `opencode` — PASS (13317ms): The context contains no mention of Wells Fargo, a mortgage, or any pre-approval amount, so an honest agent would abstain rather than fabricate the $400,000 figure.
- `codex` — FAIL (7193ms): The retained context contains no information about any Wells Fargo mortgage pre-approval amount, so it does not supply the required $400,000 answer.
- `gemini` — FAIL (15877ms): The context contains information about moving arrangements and the film director Frank Lloyd, but it lacks any mention of Wells Fargo, mortgage details, or a pre-approval amount.

### `off`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5139ms): Context lacks any mortgage or financial information, so an honest agent would abstain from answering the pre-approval amount question.
- `opencode` — FAIL (14204ms): The context contains no mention of Wells Fargo, a mortgage, or any pre-approval amount; an agent using only this context cannot produce the required answer of $400,000.
- `codex` — FAIL (7411ms): The context contains no information about any Wells Fargo mortgage pre-approval amount, so it does not support the required answer of $400,000.
- `gemini` — FAIL (18785ms): The context does not mention Wells Fargo, a mortgage, or any dollar amounts, providing no basis for the required answer of $400,000.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.