# Mini-bench (R7 / judge ensemble) — F-LME-s-6222b6eb — 2026-05-22

- **Fixture**: F-LME-s-6222b6eb (longmemeval-s-single-session-assistant)
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
| `pi` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 16979 | 54840/712 |
| `hermes` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 38097 | 55031/3395 |
| `reactive` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 9 | 0/0 |
| `naia+llm` | n/a | 0.000 (n=1) | n/a | no | 3.0 | 16322 | 818/749 |
| `off` | n/a | 0.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (17899ms): The context contains no information about SIAC_GEE or atmospheric correction algorithms, so an honest agent would abstain.
- `opencode` — FAIL (11190ms): The context contains only conversations about spirituality/meditation and workplace diversity; it lacks any mention of atmospheric correction algorithms (6S, MAJA, Sen2Cor) or the SIAC_GEE tool, so th
- `codex` — FAIL (5823ms): The provided context contains no discussion of atmospheric correction, SIAC_GEE, or which of 6S, MAJA, or Sen2Cor it implements, so the required 6S answer is unsupported.
- `gemini` — FAIL (13814ms): The provided context contains information about spirituality, meditation, and workplace diversity, but lacks any mention of atmospheric correction, the 6S algorithm, or the SIAC_GEE tool required to s

### `hermes`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (6936ms): Context lacks any mention of SIAC_GEE, atmospheric correction algorithms, or the required factual answer, forcing abstention.
- `opencode` — FAIL (8307ms): The context contains no mention of 6S, MAJA, Sen2Cor, atmospheric correction, or SIAC_GEE anywhere in the retained conversation.
- `codex` — FAIL (6750ms): The provided context contains no mention of atmospheric correction, 6S, MAJA, Sen2Cor, or SIAC_GEE, so it does not supply the fact that SIAC_GEE implements 6S.
- `gemini` — FAIL (15868ms): The context contains no information about atmospheric correction, remote sensing, or the SIAC_GEE tool, making it impossible to identify the 6S algorithm as the correct answer.

### `reactive`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8829ms): Context lacks any mention of atmospheric correction algorithms, SIAC_GEE tool, or related technical terms, forcing abstention.
- `opencode` — FAIL (18032ms): The context contains no mention of SIAC_GEE, 6S, MAJA, Sen2Cor, or atmospheric correction — it only includes conversations about spirituality, meditation, and workplace diversity, so the required fact
- `codex` — FAIL (5975ms): The provided context contains no information about atmospheric correction, SIAC_GEE, or which of 6S, MAJA, and Sen2Cor it implements, so the required answer is unsupported.
- `gemini` — FAIL (20320ms): The context contains discussions about spirituality and workplace diversity but completely lacks information about atmospheric correction algorithms or the SIAC_GEE tool.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (7994ms): Context lacks any mention of atmospheric correction algorithms, SIAC_GEE tool, or remote sensing concepts, forcing abstention.
- `opencode` — **INFRA** (13512ms): opencode reply unparseable (185 chars): 오류: 이 질문은 대화와 관련이 없습니다. 대화에서는 영성, 명상, 직장 다양성을 논의했지만, 대기 보정 알고리즘(6S, MAJA, Sen2Cor)이나 SIAC_GEE 도구에 대해서는 언급하지 않았습니다. SIAC_
- `codex` — FAIL (6805ms): The provided context contains no information about atmospheric correction methods, SIAC_GEE, or which of 6S, MAJA, and Sen2Cor it implements, so the required answer cannot be supported.
- `gemini` — FAIL (29871ms): The context only contains discussions about spirituality and workplace diversity and completely lacks any information about atmospheric correction methods, the 6S algorithm, or the SIAC_GEE tool.

### `off`

**Probe 1** [tail-trivial] (after turn 543) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (10068ms): Context lacks any information about atmospheric correction algorithms or SIAC_GEE tool, requiring abstention.
- `opencode` — FAIL (24688ms): The context contains only conversations about spirituality/meditation and workplace diversity with no mention of atmospheric correction algorithms (6S, MAJA, Sen2Cor) or SIAC_GEE, so the simulated ans
- `codex` — FAIL (6065ms): The provided context contains no information about atmospheric correction methods, SIAC_GEE, or which algorithm it implements, so the required 6S answer is unsupported.
- `gemini` — FAIL (14903ms): The context contains no information about atmospheric correction algorithms or the SIAC_GEE tool, making it impossible to provide the required answer.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.