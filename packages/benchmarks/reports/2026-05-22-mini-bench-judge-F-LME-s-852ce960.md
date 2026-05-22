# Mini-bench (R7 / judge ensemble) — F-LME-s-852ce960 — 2026-05-22

- **Fixture**: F-LME-s-852ce960 (longmemeval-s-knowledge-update)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 11494 | 65529/424 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 22495 | 65580/781 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 4 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 25886 | 790/637 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (9659ms): Context lacks any mortgage, Wells Fargo, or financial information, so an honest agent would abstain.
- `opencode` — FAIL (19379ms): The context contains no mention of Wells Fargo, mortgage pre-approval, or any dollar amount related to a home loan; the $400,000 figure is entirely absent from the retained conversation.
- `codex` — FAIL (5102ms): The context contains no information about any Wells Fargo mortgage pre-approval amount, so an agent could not truthfully answer $400,000 from this context alone.
- `gemini` — FAIL (29689ms): The context contains information about storage units and Frank Lloyd's filmography but lacks any mention of a Wells Fargo mortgage or the pre-approved amount of $400,000.

### `hermes`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6210ms): Context lacks any mortgage, Wells Fargo, or financial information, so an honest agent would abstain.
- `opencode` — FAIL (6037ms): The context contains no mention of Wells Fargo, a mortgage, or any pre-approval amount; the mortgage information required to answer '$400,000' is entirely absent from the retained context.
- `codex` — FAIL (6135ms): The context contains no information about any Wells Fargo mortgage pre-approval amount, so an agent could not answer $400,000 from this context alone.
- `gemini` — FAIL (15046ms): the context contains discussion of moving and film history but completely lacks any mention of Wells Fargo or the $400,000 mortgage amount.

### `reactive`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5391ms): Context lacks any mortgage or financial information, requiring abstention from answering the Wells Fargo pre-approval amount.
- `opencode` — PASS (9833ms): The context contains no mention of Wells Fargo, a mortgage, or any pre-approval amount, so an honest agent would abstain rather than fabricate the $400,000 figure.
- `codex` — FAIL (8477ms): The provided context contains no information about any Wells Fargo mortgage pre-approval amount, so an agent could not derive the required $400,000 answer.
- `gemini` — FAIL (16636ms): The provided context contains no mention of Wells Fargo, a mortgage, or the pre-approval amount of $400,000.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7857ms): Context lacks any mortgage or financial information, so an honest agent would abstain from answering the pre-approval amount question.
- `opencode` — FAIL (14528ms): The context contains no mention of Wells Fargo, mortgage pre-approval, or any dollar amount related to a home loan, so the required answer of $400,000 is entirely absent.
- `codex` — FAIL (12786ms): The context contains no information about any Wells Fargo mortgage pre-approval amount, so it does not support the required answer of $400,000.
- `gemini` — FAIL (17286ms): The context contains no information regarding a mortgage, Wells Fargo, or the specific pre-approval amount of $400,000 required to answer the question.

### `off`

**Probe 1** [tail-trivial] (after turn 435) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6328ms): Context lacks any mortgage or financial information, so an honest agent would abstain from answering the pre-approval amount question.
- `opencode` — FAIL (5278ms): The context contains no mention of a Wells Fargo mortgage, pre-approval amount, or any financial figure; the conversation covers moving logistics, a storage unit, and Frank Lloyd's films — the mortgag
- `codex` — FAIL (7167ms): The context contains no information about any Wells Fargo mortgage or pre-approval amount, so it does not support answering $400,000.
- `gemini` — FAIL (63895ms): The provided context contains no mention of a mortgage amount, Wells Fargo, or the specific figure of $400,000 required to satisfy the pass criterion.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.