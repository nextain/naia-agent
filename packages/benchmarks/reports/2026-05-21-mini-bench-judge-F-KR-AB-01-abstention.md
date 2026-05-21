# Mini-bench (judge ensemble) — F-KR-AB-01-abstention — 2026-05-21

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12179ms): The context only mentions the user's birthday is "next week" without providing a specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — PASS (16788ms): 컨텍스트는 사용자가 "다음주 생일"이라고만 언급했으며 구체적인 날짜는 절대 제공하지 않았음을 명확히 보여주므로, 에이전트가 정확히 기일을 모른다고 올바르게 기각할 수 있습니다.
- `codex` — PASS (11164ms): 문맥에는 사용자가 생일이 다음 주라고만 말했을 뿐 실제 날짜는 한 번도 제공하지 않아 모른다고 답해야 한다.
- `gemini` — PASS (11278ms): The context shows the user mentioned their birthday is next week but never provided a specific date, allowing the agent to correctly abstain.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13207ms): The context contains no information about the user's birthday, so the agent should abstain from providing a specific date.
- `opencode` — PASS (7936ms): 생일과 관련된 어떤 정보도 CONTEX에 전혀 포함되어 있지 않으므로, 에이전트는 생일 정보를 알 수 없거나 제공된 적 없다고 정확하게 판단할 수 있습니다.
- `codex` — PASS (13934ms): 제공된 대화 맥락에는 사용자의 생일 정보가 전혀 없으므로 모른다고 답하는 것이 기준에 부합한다
- `gemini` — FAIL (60172ms): 패스 기준에서 명시한 '다음주' 생일 언급(Turn 27)을 포함하여 질문과 직결된 최근 14개 턴이 압축 과정에서 유실됨.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (47695ms): The context mentions the user has a birthday next week but doesn't provide the specific date, so the agent should correctly abstain from providing a specific date.
- `opencode` — PASS (11807ms): 컨텍스트에서 사용자는 "다음주 생일"이라고만 언급했을 뿐, 구체적인 날짜는 한 번도 제공하지 않았으므로, 올바른 응답은 사용자가 생일을 알려준 적 없다고 기각하는 것이다.
- `codex` — PASS (6175ms): 문맥에는 사용자가 생일이 다음주라고만 말했을 뿐 정확한 날짜를 제공한 적이 없으므로 모른다고 답해야 합니다.
- `gemini` — PASS (13150ms): The context confirms the user only mentioned their birthday is next week without specifying a date, providing sufficient information for the agent to correctly state it does not know the exact day.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (66602ms): The context mentions the user has a birthday next week but doesn't provide the specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — PASS (11917ms): CONTEXT에서 사용자가 "다음주 생일"이라고만 했고 구체적 날짜는 언급하지 않았으므로, 정확한 생일을 모른다고 abstain할 충분한 정보가 있음.
- `codex` — PASS (7834ms): 컨텍스트에는 사용자가 생일이 다음주라고만 말했을 뿐 실제 날짜는 전혀 없어서 생일을 모른다고 답해야 한다.
- `gemini` — PASS (14308ms): 사용자가 생일이 다음주라고만 언급했을 뿐 구체적인 날짜나 월일 정보를 제공한 기록이 대화 내역에 전혀 존재하지 않음.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16078ms): The context shows the user mentioned their birthday is "next week" but never provided a specific date, so the agent should abstain from providing a specific date.
- `opencode` — PASS (14042ms): 컨텍스트는 사용자가 "다음주 생일"이라고만 말했으며 구체적인 날짜를 전혀 밝히지 않았음을 명확히 보여주므로, 응답 금지가 제공된 정보에 대한 정확한 반영입니다.
- `codex` — PASS (7794ms): CONTEXT only says 다음주 생일이라 며칠 휴가 쓸 수도 있다고 했을 뿐 실제 생일 날짜는 한 번도 제공되지 않았으므로 모른다고 답해야 한다
- `gemini` — PASS (14454ms): The context mentions the birthday is next week but does not provide a specific date, allowing the agent to correctly abstain as required.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
