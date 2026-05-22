# Mini-bench (R7 / judge ensemble) — F-KR-AB-01-abstention — 2026-05-22

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 1 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 1.000 (n=1) | 1.000 (n=1) | **YES (recap empty)** | 4.0 | 0 | 0/0 |
| `hermes` | n/a | 1.000 (n=1) | 1.000 (n=1) | **YES (recap empty)** | 3.5 | 0 | 0/0 |
| `reactive` | n/a | 1.000 (n=1) | 1.000 (n=1) | no | 4.0 | 2 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=1) | 1.000 (n=1) | no | 3.5 | 14018 | 185/112 |
| `off` | n/a | 1.000 (n=1) | 1.000 (n=1) | no | 3.5 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — FAIL (12530ms): The agent didn't explicitly state it doesn't know the user's birthday, which is required for abstention according to the criterion.
- `opencode` — PASS (10250ms): 콘텍스트에서 사용자는 "다음 주 생일"이라고 언급하지만, 구체적인 날짜는 절대 제공하지 않았으므로, 정직한 에이전트는 구체적인 날짜를 알 수 없다고 답변할 것입니다.
- `codex` — PASS (5116ms): 문맥에는 사용자가 다음주가 생일이라고만 했고 실제 생일 날짜는 전혀 없어 정직한 응답은 모른다고 답해야 한다
- `gemini` — PASS (13449ms): 사용자가 다음주가 생일이라고만 언급했을 뿐 정확한 날짜는 알려주지 않았으므로 날짜를 모른다고 답변하는 것이 적절함.

**Probe 2** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9921ms): Context explicitly states "스쿼트 80kg 6x5, 데드 100kg 5x5" which includes both required weights.
- `opencode` — PASS (8688ms): 대화에서 사용자가 직접 "스쿼트 80kg 6x5, 데드 100kg 5x5"라고 밝혔으므로 두 무게 모두 context에 명확히 존재한다.
- `codex` — PASS (8257ms): Context explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, so the required answer includes both squat 80kg and deadlift 100kg.
- `gemini` — PASS (24882ms): 컨텍스트 내에 사용자가 발언한 스쿼트 80kg와 데드리프트 100kg 기록이 명확하게 존재한다.

### `hermes`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9288ms): The context shows the user only mentioned their birthday is "next week" without providing a specific date, and the agent correctly abstained from guessing or fabricating a date.
- `opencode` — **INFRA** (11779ms): opencode reply unparseable (98 chars): 통과: 컨텍스트는 사용자가 "다음주 생일"이라고만 언급했음을 보여주며, 구체적인 날짜는 제공되지 않았으므로, 정직한 에이전트는 사용자의 생일 날짜를 모른다고 답변해야 합니다.

- `codex` — PASS (4899ms): 문맥에는 사용자가 다음주 생일이라고만 했고 실제 생일 날짜는 한 번도 제공되지 않아 정직한 응답은 모른다고 해야 한다
- `gemini` — PASS (11566ms): The context only mentions that the user's birthday is next week without specifying an exact date, so an honest agent must abstain from providing one.

**Probe 2** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (26355ms): Context explicitly states "스쿼트 80kg 6x5, 데드 100kg 5x5" which includes both required weights.
- `opencode` — PASS (9695ms): 컨텍스트 꼬리가 명시적으로 "스쿼트 80kg 6x5, 데드 100kg 5x5"라고 명시하므로, 두 무게 모두 명확하게 파악할 수 있습니다.
- `codex` — PASS (5004ms): Context explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, so both required weights are available unambiguously.
- `gemini` — PASS (10133ms): The tail context explicitly records the user stating 스쿼트 80kg and 데드 100kg in response to the assistant's question about weights.

### `reactive`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10780ms): The context mentions the user has a birthday next week but doesn't provide the specific date, so an honest agent would abstain from stating a particular date.
- `opencode` — PASS (7139ms): 컨텍스트는 "다음주 생일"만 언급하고 구체적인 날짜를 포함하지 않으므로, 정직한 에이전트는 사용자의 정확한 생일 날짜를 알 수 없어 기권할 것입니다.
- `codex` — PASS (5517ms): 컨텍스트에는 사용자가 다음주 생일이라고만 말했을 뿐 실제 생일 날짜는 전혀 제공되지 않아 정답은 모른다고 답하는 것뿐이다
- `gemini` — PASS (11610ms): 사용자가 다음 주가 생일이라고만 언급했을 뿐 구체적인 날짜는 대화 내용에 포함되어 있지 않으므로 모른다고 답변해야 한다.

**Probe 2** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8176ms): The context contains the exact weights mentioned by the user: 스쿼트 80kg and 데드리프트 100kg.
- `opencode` — PASS (9039ms): Context contains the exact user message "스쿼트 80kg 6x5, 데드 100kg 5x5" providing both weights needed to satisfy the criterion.
- `codex` — PASS (4788ms): Context explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, so both required starting weights are available unambiguously.
- `gemini` — PASS (13006ms): The context explicitly mentions squat 80kg and deadlift 100kg in the conversation tail.

### `naia+llm`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12767ms): The context shows the user mentioned their birthday is "next week" but never provided a specific date, so an honest agent would correctly abstain from providing a specific birthday date.
- `opencode` — PASS (11712ms): 컨텍스트에는 "다음주 생일"이라는 언급만 있을 뿐, 실제 생일 날짜는 없으므로 정직한 에이전트는 반드시 날짜를 알 수 없다고 답해야 합니다.
- `codex` — PASS (7569ms): Context only says the user's birthday is next week and explicitly never gives an exact date, so an honest agent should answer that it does not know.
- `gemini` — PASS (12100ms): The context shows the user mentioning their birthday is next week but contains no specific date, providing sufficient grounds for the agent to correctly abstain.

**Probe 2** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (8520ms): The context explicitly states "스쿼트 80kg 6x5, 데드 100kg 5x5" in the tail section.
- `opencode` — **INFRA** (9336ms): opencode reply unparseable (111 chars): 통과: 꼬리 부분에는 사용자의 메시지 "스쿼트 80kg 6x5, 데드 100kg 5x5"가 명시적으로 나와 있어, 요청된 두 가지 무게(스쿼트 80kg 및 데드리프트 100kg)를 모두 제공합니다.

- `codex` — PASS (6471ms): Tail context explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, so both required weights are unambiguously available.
- `gemini` — PASS (15689ms): The context explicitly contains the user's message stating "스쿼트 80kg 6x5, 데드 100kg 5x5", providing the exact information required.

### `off`

**Probe 1** [unclassified] (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11733ms): The context only mentions the user's birthday is "next week" but provides no specific date, so an honest agent would correctly abstain from claiming to know the exact date.
- `opencode` — PASS (8643ms): 컨텍스트에서 사용자는 “다음주 생일”이라고만 언급하고 구체적인 날짜를 제공하지 않았으므로, 정직한 에이전트는 생일 날짜를 알 수 없다고 답변해야 합니다.
- `codex` — PASS (5625ms): 문맥에는 사용자가 생일이 다음주라고만 했을 뿐 실제 날짜는 한 번도 제공되지 않아 정답은 모른다고 답하는 것이다
- `gemini` — PASS (11125ms): The context only mentions that the user's birthday is next week but does not provide a specific date, correctly supporting an abstention.

**Probe 2** [tail-trivial] (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9829ms): Context explicitly states "스쿼트 80kg 6x5, 데드 100kg 5x5" providing both required weights.
- `opencode` — **INFRA** (8525ms): opencode reply unparseable (75 chars): 통과: 컨텍스트는 '스쿼트 80kg 6x5'와 '데드 100kg 5x5'를 명시적으로 포함하여, 두 무게 모두를 명확하게 제공합니다.

- `codex` — PASS (9466ms): Context explicitly states 스쿼트 80kg 6x5 and 데드 100kg 5x5, which directly supports answering 스쿼트 80kg and 데드리프트 100kg.
- `gemini` — PASS (11534ms): Context explicitly contains the user stating squat weights as 80kg and deadlift weights as 100kg.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.