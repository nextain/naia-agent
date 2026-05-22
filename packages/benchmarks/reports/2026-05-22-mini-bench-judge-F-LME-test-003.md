# Mini-bench (R7 / judge ensemble) — F-LME-test-003 — 2026-05-22

- **Fixture**: F-LME-test-003 (longmemeval-single-session-user)
- **Strategies**: pi, hermes, reactive, naia+llm, off
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
| `pi` | n/a | n/a | 1.000 (n=1) | **YES (recap empty)** | 4.0 | 0 | 0/0 |
| `hermes` | n/a | n/a | 1.000 (n=1) | **YES (recap empty)** | 3.0 | 0 | 0/0 |
| `reactive` | n/a | n/a | 1.000 (n=1) | no | 4.0 | 1 | 0/0 |
| `naia+llm` | n/a | n/a | 1.000 (n=1) | no | 4.0 | 9845 | 176/31 |
| `off` | n/a | n/a | 1.000 (n=1) | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11363ms): The user explicitly stated they haven't decided on a favorite dish yet, which means they haven't mentioned their favorite food in the conversation history.
- `opencode` — PASS (4691ms): The context explicitly contains the user stating "I haven't decided on a favorite dish yet," which supports the required answer that the user has not mentioned their favorite food.
- `codex` — PASS (5619ms): The only relevant context says the user has not decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (10231ms): The context includes the user's explicit statement that they have not yet decided on a favorite dish, allowing the agent to correctly report that the information is unknown.

### `hermes`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9516ms): The context contains the user's statement that they haven't decided on a favorite dish yet, which means they haven't mentioned their favorite food in the conversation history.
- `opencode` — **INFRA** (6505ms): opencode reply unparseable (98 chars): 통과: 컨텍스트는 사용자가 아직 좋아하는 요리를 결정하지 못했다고 명시적으로 말하므로, 정직한 에이전트는 사용자가 좋아하는 음식을 언급하지 않았다고 올바르게 대답할 것입니다.

- `codex` — PASS (4816ms): The only relevant context says the user has not decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned in the conversation history.
- `gemini` — PASS (10045ms): The context contains the user's explicit statement that they have not yet decided on a favorite dish.

### `reactive`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (5819ms): The context explicitly states the user hasn't decided on a favorite dish yet, supporting the required answer.
- `opencode` — PASS (5787ms): Context explicitly states "I haven't decided on a favorite dish yet," so an agent would correctly indicate the user has not mentioned a favorite food.
- `codex` — PASS (5200ms): The context explicitly says the user has not decided on a favorite dish yet and nowhere names any favorite food, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (10234ms): The context explicitly states the user hasn't decided on a favorite dish yet, enabling the agent to correctly report its absence.

### `naia+llm`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (74824ms): The context explicitly states the user "hasn't decided on a favorite dish yet," which directly supports the required answer that the user has not mentioned their favorite food.
- `opencode` — PASS (4570ms): The context explicitly states the user "hasn't decided on a favorite dish yet," so an honest agent would acknowledge the user has not mentioned their favorite food.
- `codex` — PASS (4578ms): The context explicitly says the user has not decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (8990ms): The context contains the user's explicit statement that they haven't decided on a favorite dish yet, supporting the answer that it hasn't been mentioned.

### `off`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9011ms): The user explicitly stated they "haven't decided on a favorite dish yet," which clearly indicates they haven't mentioned a favorite food in the conversation.
- `opencode` — PASS (6046ms): 사용자가 컨텍스트에서 아직 좋아하는 요리를 결정하지 못했다고 명시적으로 말했으므로, 에이전트는 좋아하는 음식이 언급되지 않았다고 올바르게 응답할 것입니다.
- `codex` — PASS (7481ms): The context explicitly says the user has not decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (11478ms): The context explicitly states the user has not decided on a favorite dish yet, enabling the agent to correctly abstain as required.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.