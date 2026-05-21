# Mini-bench (R7 / judge ensemble) — F-LME-test-003 — 2026-05-21

- **Fixture**: F-LME-test-003 (longmemeval-single-session-user)
- **Strategies**: reactive, reactive-vercel, realtime, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 1 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `reactive` | n/a | n/a | 1.000 (n=1) | no | 4.0 |
| `reactive-vercel` | n/a | n/a | 1.000 (n=1) | no | 4.0 |
| `realtime` | n/a | n/a | 1.000 (n=1) | no | 4.0 |
| `off` | n/a | n/a | 1.000 (n=1) | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (7539ms): The context contains the user's explicit statement that they "haven't decided on a favorite dish yet," which directly supports the required answer that the user hasn't mentioned their favorite food.
- `opencode` — PASS (8621ms): The recap and tail both show the user stating "I haven't decided on a favorite dish yet," so the context lacks any favorite food and an honest agent would correctly respond that the user has not menti
- `codex` — PASS (7148ms): The context explicitly says the user has not decided on a favorite dish yet and contains no favorite food, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (9831ms): The context explicitly states the user hasn't decided on a favorite dish yet, allowing the agent to correctly report that the information hasn't been mentioned.

### `reactive-vercel`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11185ms): The context contains the user's statement that they "haven't decided on a favorite dish yet," which supports the required answer that the user has not mentioned their favorite food.
- `opencode` — PASS (7896ms): The context explicitly states "I haven't decided on a favorite dish yet," which directly supports the required answer that the user has not mentioned their favorite food.
- `codex` — PASS (10357ms): The context explicitly says the user has not decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (9828ms): The context explicitly contains the user's statement that they have not yet decided on a favorite dish.

### `realtime`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6103ms): The context explicitly states the user hasn't decided on a favorite dish yet, supporting the required answer that they haven't mentioned a favorite food.
- `opencode` — PASS (5585ms): The context explicitly states "I haven't decided on a favorite dish yet," so an agent would correctly indicate the user has not mentioned a favorite food and would abstain from naming one.
- `codex` — PASS (12286ms): The context explicitly says the user hasn't decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned or established.
- `gemini` — PASS (9309ms): The context explicitly shows the user stating they have not decided on a favorite dish yet, allowing the agent to correctly report that the information is unknown.

### `off`

**Probe 1** [unclassified] (after turn 2) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8011ms): The context contains the user's explicit statement that they "haven't decided on a favorite dish yet," which directly supports the required answer that the user has not mentioned their favorite food.
- `opencode` — PASS (6412ms): The context clearly shows the user has not decided on a favorite dish ("I haven't decided on a favorite dish yet"), so an honest agent would report that the user hasn't mentioned their favorite food.
- `codex` — PASS (6162ms): The context explicitly says the user has not decided on a favorite dish yet, so an honest answer is that their favorite food has not been mentioned.
- `gemini` — PASS (9450ms): The context explicitly shows the user stating they have not decided on a favorite dish yet, allowing the agent to correctly conclude it hasn't been mentioned.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.