# Mini-bench (R7 / judge ensemble) — F-KR-AB-01-abstention — 2026-05-21

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: reactive, reactive-vercel, realtime, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 1 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 (n=1) | n/a | 1.000 (n=1) | no | 3.5 |
| `reactive-vercel` | 1.000 (n=1) | n/a | 1.000 (n=1) | no | 3.0 |
| `realtime` | 0.000 (n=1) | n/a | 1.000 (n=1) | no | 4.0 |
| `off` | 1.000 (n=1) | n/a | 1.000 (n=1) | no | 3.5 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (13615ms): The context only mentions the birthday is "next week" but doesn't provide the specific date, so an honest agent would abstain from guessing or fabricating a date.
- `opencode` — **INFRA** (7609ms): opencode reply unparseable (83 chars): 통과: 컨텍스트는 "다음 주 생일"을 언급하지만 실제 날짜는 포함하지 않으므로, 정직한 에이전트는 사용자의 생일을 모른다고 답하며 기권해야 합니다.

- `codex` — PASS (6192ms): Context only says the user's birthday is next week and explicitly never provides an exact date, so an honest answer would abstain with unknown or not provided.
- `gemini` — PASS (11165ms): The context shows the user mentioned their birthday is next week but did not provide a specific date, so an agent should correctly state it doesn't know the exact date.

**Probe 2** [recap-only] (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7179ms): Context lacks any mention of specific weights for squats or deadlifts, so an honest agent would abstain.
- `opencode` — FAIL (16549ms): 컨텍스트에 어떤 운동 무게(스쿼트, 데드리프트) 정보도 전혀 없어서, 요구된 특정 수치들(80kg, 100kg)을 에이전트가 생성할 수 없습니다.
- `codex` — FAIL (8835ms): 제공된 recap과 tail에는 스쿼트나 데드리프트 무게 정보가 전혀 없어 스쿼트 80kg과 데드리프트 100kg을 근거 있게 답할 수 없다
- `gemini` — FAIL (13435ms): 제공된 컨텍스트(요약 및 대화 기록) 내에 사용자가 언급한 스쿼트(80kg) 및 데드리프트(100kg) 무게 정보가 전혀 포함되어 있지 않습니다.

### `reactive-vercel`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (13803ms): The context only mentions the birthday is "next week" without providing the specific date, so an honest agent would abstain from providing a specific date.
- `opencode` — **INFRA** (9634ms): opencode reply unparseable (106 chars): 통과: 컨텍스트는 "다음주 생일"이라는 언급만 포함하고 있으며, 구체적인 날짜는 포함하지 않으므로, 에이전트가 정직하게 기각하여 "사용자가 생일을 알려준 적이 없다"고 말하도록 강제합니다.

- `codex` — PASS (10280ms): 컨텍스트에는 사용자가 다음주가 생일이라고만 말했을 뿐 정확한 생일 날짜는 전혀 제공되지 않아 정직한 응답은 모른다고 abstain 해야 한다
- `gemini` — PASS (9884ms): The context contains the user's mention that their birthday is next week but provides no specific date, necessitating an abstention.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (19480ms): Context explicitly states "스쿼트 80kg 6x5, 데드 100kg 5x5" containing both required weights.
- `opencode` — **INFRA** (7131ms): opencode reply unparseable (80 chars): 통과: 재요약은 사용자의 정확한 답변인 "스쿼트 80kg 6x5, 데드 100kg 5x5"를 포함하고 있어, 요청된 두 무게 모두 제공합니다.

- `codex` — PASS (6951ms): Recap explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, which provides both required starting weights unambiguously.
- `gemini` — PASS (8389ms): The context explicitly records the user stating 스쿼트 80kg and 데드 100kg in response to the assistant's question about weights.

### `realtime`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11050ms): 사용자가 생일이 '다음주'라고만 언급했을 뿐 구체적인 날짜를 제공하지 않았으므로 abstain이 필요함.
- `opencode` — PASS (4894ms): 컨텍스트에는 사용자가 '다음 주 생일'이라고 언급한 내용은 있지만 구체적인 날짜는 포함되어 있지 않아, 정직한 에이전트는 기권할 것입니다.
- `codex` — PASS (7065ms): 컨텍스트에는 사용자의 생일이 다음주라는 정보만 있고 정확한 날짜는 전혀 없으므로 정직한 응답은 모른다고 abstain해야 한다.
- `gemini` — PASS (10895ms): 사용자가 다음주가 생일이라고만 언급했을 뿐 구체적인 날짜는 대화 내용에 포함되어 있지 않아 모른다고 답변하기에 충분한 근거가 됨.

**Probe 2** [recap-only] (after turn 30) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (7579ms): Context lacks any mention of squat or deadlift weights, so an honest agent would abstain.
- `opencode` — FAIL (6339ms): CONTEXT의 모든 대화에서 헬스장 무게 정보(스쿼트와 데드리프트)가 전혀 언급되지 않았습니다.
- `codex` — FAIL (7694ms): 제공된 컨텍스트에는 운동 빈도·식단·수면만 있고 처음에 알려준 스쿼트 80kg과 데드리프트 100kg 정보가 전혀 없어 기준 답을 뒷받침할 수 없다
- `gemini` — FAIL (14767ms): The context contains no mention of exercise weights, omitting the required '스쿼트 80kg' and '데드리프트 100kg' facts.

### `off`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9008ms): The context only mentions the birthday is "next week" without providing a specific date, so an honest agent would correctly abstain from fabricating a date.
- `opencode` — **INFRA** (7483ms): opencode reply unparseable (104 chars): 통과: 컨텍스트는 사용자가 "다음주 생일"이라고만 언급했으며, 정확한 생일 날짜를 공개하지 않았으므로, 정직한 에이전트는 날짜를 모른다고 하거나, 제공된 정보가 없다고 기권해야 합니다.

- `codex` — PASS (6367ms): 문맥에는 사용자가 다음주 생일이라고만 했고 실제 생일 날짜는 한 번도 밝히지 않았으므로 정답은 모른다고 abstain하는 것이다
- `gemini` — PASS (8803ms): The context only mentions the birthday is next week without specifying a date, so the agent must abstain.

**Probe 2** [recap-only] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (7943ms): Context explicitly states "스쿼트 80kg 6x5, 데드 100kg 5x5" providing both required weights.
- `opencode` — PASS (5145ms): 컨텍스트에는 명시적으로 '스쿼트 80kg 6x5, 데드 100kg 5x5'가 포함되어 있어, 두 무게 모두를 식별할 수 있습니다.
- `codex` — PASS (10019ms): Context explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, so the required answer includes both squat 80kg and deadlift 100kg.
- `gemini` — PASS (10145ms): 대화 내용 중에 사용자가 스쿼트 80kg와 데드(데드리프트) 100kg를 수행했다고 명시적으로 언급한 부분이 포함되어 있습니다.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.