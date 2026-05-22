# Mini-bench (R7 / judge ensemble) — F-LME-test-001 — 2026-05-22

- **Fixture**: F-LME-test-001 (longmemeval-single-session-user)
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
| `pi` | n/a | 1.000 (n=1) | n/a | **YES (recap empty)** | 3.0 | 0 | 0/0 |
| `hermes` | n/a | 1.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 0 | 0/0 |
| `reactive` | n/a | 1.000 (n=1) | n/a | no | 3.0 | 1 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 7757 | 177/20 |
| `off` | n/a | 1.000 (n=1) | n/a | no | 3.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (10413ms): The context explicitly states the user's favorite color is blue in the conversation history.
- `opencode` — **INFRA** (6626ms): opencode reply unparseable (103 chars): 통과: 컨텍스트에는 사용자가 "내가 가장 좋아하는 색은 파란색"이라고 명시하고 어시스턴트가 이를 확인하여, '파란색'이라는 필수 답변에 대한 명확하고 모호하지 않은 정보를 제공합니다.

- `codex` — PASS (5428ms): The tail explicitly states that the user Alice said her favorite color is blue, so the context supports answering Blue.
- `gemini` — PASS (10414ms): The context explicitly contains the user's statement that their favorite color is blue and the assistant's confirmation of this fact.

### `hermes`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6725ms): The context explicitly states the user's favorite color is blue.
- `opencode` — PASS (4674ms): The context contains the user's explicit statement "my favorite color is blue" and the assistant's confirmation, so an agent would correctly answer blue.
- `codex` — PASS (4681ms): The tail explicitly states that the user said their favorite color is blue and the assistant acknowledged remembering it.
- `gemini` — PASS (9844ms): The context contains the user's explicit statement that their favorite color is blue.

### `reactive`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (7028ms): The context explicitly states the user's favorite color is blue in both the recap and tail messages.
- `opencode` — **INFRA** (5785ms): opencode reply unparseable (90 chars): 통과: 요약본과 원본 사용자 메시지 모두 "My favorite color is blue"라고 명시하고 있어, 파란색이라는 답변을 명확하게 도출할 수 있습니다.

- `codex` — PASS (5895ms): The context explicitly states twice that the user's favorite color is blue, so the agent can answer Blue unambiguously.
- `gemini` — PASS (10107ms): The context explicitly mentions that the user's name is Alice and her favorite color is blue in both the recap and the tail messages.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8569ms): The context explicitly states Alice's favorite color is blue in both the recap and tail.
- `opencode` — PASS (3886ms): The context explicitly states in both the recap and tail that the user's favorite color is blue.
- `codex` — PASS (7071ms): The context explicitly states that Alice's favorite color is blue in both the recap and the tail, so the agent can answer Blue.
- `gemini` — PASS (11670ms): The context explicitly states in both the recap and the message history that the user's favorite color is blue.

### `off`

**Probe 1** [tail-trivial] (after turn 2) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (14028ms): The context explicitly states that Alice's favorite color is blue, allowing the agent to correctly answer 'Blue' or a paraphrase.
- `opencode` — **INFRA** (6250ms): opencode reply unparseable (72 chars): 통과: 컨텍스트에 "제가 가장 좋아하는 색상은 파란색입니다"라고 명시되어 있어, 기준에 맞는 명확한 답변을 제공할 수 있습니다.

- `codex` — PASS (4717ms): The context explicitly states that Alice's favorite color is blue, so the agent can answer Blue unambiguously.
- `gemini` — PASS (10052ms): The context contains the user's explicit statement that their favorite color is blue.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.