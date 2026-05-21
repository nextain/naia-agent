# Mini-bench (R7 / judge ensemble) — F-LME-test-002 — 2026-05-21

- **Fixture**: F-LME-test-002 (longmemeval-multi-session)
- **Strategies**: reactive, reactive-vercel, realtime, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

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
| `reactive` | n/a | 1.000 (n=1) | n/a | no | 4.0 |
| `reactive-vercel` | n/a | 1.000 (n=1) | n/a | no | 4.0 |
| `realtime` | n/a | 1.000 (n=1) | n/a | no | 4.0 |
| `off` | n/a | 1.000 (n=1) | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6540ms): The context explicitly states the user got a golden retriever named Max in the tail message.
- `opencode` — PASS (5385ms): Context contains "I got a golden retriever! His name is Max." and the assistant confirmed it, providing exactly the required answer.
- `codex` — PASS (6745ms): The context explicitly states in the later session that the user got a golden retriever and his name is Max, so the agent can answer A golden retriever named Max.
- `gemini` — PASS (12431ms): The context explicitly mentions that the user got a golden retriever named Max in the most recent session of the tail.

### `reactive-vercel`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11547ms): The context explicitly states the user got a golden retriever named Max in the tail section.
- `opencode` — PASS (6000ms): The context contains the user's explicit statement "I got a golden retriever! His name is Max." across session boundaries, providing all information needed to answer.
- `codex` — PASS (7409ms): The context explicitly states in Session 2 that the user got a golden retriever and that his name is Max, so the agent can answer A golden retriever named Max.
- `gemini` — PASS (20086ms): The context explicitly states the user has a golden retriever named Max in the session 2 tail.

### `realtime`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9864ms): The context contains the user's statement "I got a golden retriever! His name is Max" which directly answers the question about what pet they have.
- `opencode` — PASS (4667ms): The context contains "I got a golden retriever! His name is Max." which directly provides the answer.
- `codex` — PASS (20089ms): The context explicitly states in Session 2 that the user got a golden retriever and that his name is Max, which directly supports answering A golden retriever named Max.
- `gemini` — PASS (8849ms): The context explicitly states the user got a golden retriever named Max in the recent message history.

### `off`

**Probe 1** [tail-trivial] (after turn 5) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6974ms): The context explicitly states the user has a golden retriever named Max, which satisfies the criterion.
- `opencode` — PASS (5879ms): Context includes "I got a golden retriever! His name is Max." which directly provides the answer.
- `codex` — PASS (6822ms): The context explicitly states in Session 2 that the user got a golden retriever and his name is Max, so the agent can answer that the pet is a golden retriever named Max.
- `gemini` — PASS (8739ms): The context explicitly mentions the user got a golden retriever named Max in the second session.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.