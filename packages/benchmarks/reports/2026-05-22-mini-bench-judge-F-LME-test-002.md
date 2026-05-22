# Mini-bench (R7 / judge ensemble) — F-LME-test-002 — 2026-05-22

- **Fixture**: F-LME-test-002 (longmemeval-multi-session)
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
| `pi` | n/a | 1.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 0 | 0/0 |
| `hermes` | n/a | 1.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 0 | 0/0 |
| `reactive` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 1 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 10445 | 210/84 |
| `off` | n/a | 1.000 (n=1) | n/a | no | 3.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (22071ms): The context contains the user's explicit statement "I got a golden retriever! His name is Max" which directly supports the required answer.
- `opencode` — PASS (9587ms): The context contains the user's explicit statement "I got a golden retriever! His name is Max" across a session boundary, providing the exact answer needed.
- `codex` — PASS (5107ms): The tail explicitly states in Session 2 that the user got a golden retriever and his name is Max, which directly supports answering A golden retriever named Max.
- `gemini` — PASS (11210ms): The tail of the context explicitly mentions that the user got a golden retriever named Max.

### `hermes`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (24774ms): The context contains the user's explicit statement "I got a golden retriever! His name is Max" which directly answers the question about what pet the user has.
- `opencode` — PASS (5915ms): The context directly states "I got a golden retriever! His name is Max" in the tail conversation, providing exactly the information required by the criterion.
- `codex` — PASS (5325ms): The context explicitly states in Session 2 that the user got a golden retriever and that his name is Max, so the agent can answer A golden retriever named Max.
- `gemini` — PASS (9631ms): The context contains the user's explicit statement 'I got a golden retriever! His name is Max.', providing all necessary information.

### `reactive`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6245ms): The context contains the user's explicit statement "I got a golden retriever! His name is Max."
- `opencode` — PASS (5722ms): The tail section includes "I got a golden retriever! His name is Max," which directly supplies the required answer.
- `codex` — PASS (5330ms): The context explicitly states in Session 2 that the user got a golden retriever and his name is Max, so the answer is a golden retriever named Max.
- `gemini` — PASS (9108ms): The context explicitly contains the user's statement that they got a golden retriever named Max in the most recent session transcript.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6341ms): The context explicitly states the user got a golden retriever named Max in the tail section.
- `opencode` — PASS (4532ms): The tail contains the user's explicit statement "I got a golden retriever! His name is Max," which directly answers the question.
- `codex` — PASS (6347ms): The context explicitly states in Session 2 that the user got a golden retriever and that his name is Max, which supports answering A golden retriever named Max.
- `gemini` — PASS (16906ms): The tail explicitly contains the user's statement "I got a golden retriever! His name is Max" and the assistant's confirmation of these facts.

### `off`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (6540ms): The context contains the user's statement "I got a golden retriever! His name is Max" which directly answers the question.
- `opencode` — **INFRA** (5295ms): opencode reply unparseable (97 chars): 통과: 사용자가 컨텍스트에서 "I got a golden retriever! His name is Max."라고 명시적으로 말하므로, 질문에 대한 정보가 충분히 제공됩니다.

- `codex` — PASS (4909ms): The context explicitly states in Session 2 that the user got a golden retriever and that his name is Max, so the required answer is unambiguous.
- `gemini` — PASS (12214ms): The context explicitly mentions that the user got a golden retriever named Max in Session 2.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.