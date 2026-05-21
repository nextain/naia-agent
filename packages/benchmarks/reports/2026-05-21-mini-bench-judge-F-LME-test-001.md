# Mini-bench (R7 / judge ensemble) — F-LME-test-001 — 2026-05-21

- **Fixture**: F-LME-test-001 (longmemeval-single-session-user)
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
| `off` | n/a | 1.000 (n=1) | n/a | no | 3.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8810ms): The context explicitly states "my favorite color is blue" in both the recap and tail messages.
- `opencode` — PASS (5789ms): The context explicitly states "my favorite color is blue" twice (in the recap and in the tail's user message), and the assistant also confirms it.
- `codex` — PASS (10218ms): The context explicitly states that the user's favorite color is blue in both the recap and the tail, so the agent can answer Blue unambiguously.
- `gemini` — PASS (10258ms): The context explicitly states multiple times that the user's name is Alice and her favorite color is blue.

### `reactive-vercel`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (17323ms): The context explicitly states that the user's favorite color is blue.
- `opencode` — PASS (7220ms): Context explicitly states "my favorite color is blue" twice (user message and assistant confirmation), so an agent would answer "blue" satisfying the criterion.
- `codex` — PASS (5493ms): The context explicitly states that the user's favorite color is blue in both the recap and tail, so the agent can answer Blue unambiguously.
- `gemini` — PASS (9856ms): The context explicitly contains the user's statement that their favorite color is blue in both the recap and the tail.

### `realtime`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8843ms): The context explicitly states "my favorite color is blue" in both the recap and tail, providing the required fact for the answer.
- `opencode` — PASS (7318ms): The recap and tail both explicitly state "My name is Alice and my favorite color is blue," directly supplying the answer "Blue."
- `codex` — PASS (9553ms): The context explicitly states that Alice's favorite color is blue in both the user message and the assistant's acknowledgment, so the agent can answer Blue unambiguously.
- `gemini` — PASS (10117ms): The context explicitly states in both the conversation recap and the message history that the user's favorite color is blue.

### `off`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (8905ms): The context explicitly states that Alice's favorite color is blue, allowing the agent to correctly answer 'Blue' without abstention or fabrication.
- `opencode` — **INFRA** (7230ms): opencode reply unparseable (86 chars): 통과: 컨텍스트에는 "내가 가장 좋아하는 색상은 파란색"과 보조 기억 확인이 명시적으로 포함되어 있어, 파란색이라는 정답을 명확하게 도출할 수 있습니다.

- `codex` — PASS (10034ms): The context explicitly states that Alice's favorite color is blue, so the agent can answer Blue unambiguously.
- `gemini` — PASS (8788ms): The context explicitly states the user's favorite color is blue in the first message.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.