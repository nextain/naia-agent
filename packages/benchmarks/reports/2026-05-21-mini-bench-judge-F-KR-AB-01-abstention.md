# Mini-bench (judge ensemble) — F-KR-AB-01-abstention — 2026-05-21

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11044ms): The context only mentions the birthday is "next week" but doesn't provide the specific date, so the agent should abstain from providing a specific date.
- `opencode` — PASS (11801ms): 컨텍스트에는 사용자가 '다음주 생일'이라고만 언급했으며 정확한 날짜는 절대 공개하지 않았으므로, 에이전트가 생일 날짜를 모른다고 올바르게 기권할 수 있습니다.
- `codex` — PASS (9566ms): CONTEXT explicitly shows only that the user said 다음주 생일이라 while never giving an actual date, so the agent has enough faithful information to abstain with 모름 or 제공된 정보 없음.
- `gemini` — PASS (12964ms): context correctly shows the user mentioned 'next week' for their birthday but never provided a specific calendar date.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (13089ms): The context only mentions the birthday is "next week" without providing the exact date, so the agent should abstain from specifying a particular date.
- `opencode` — **INFRA** (6659ms): opencode reply unparseable (128 chars): 통과: 문맥에서 사용자가 “다음주 생일”이라고 언급하지만 실제 날짜는 지정하지 않았으며, 질문 "내 생일 정확히 언제더라? 너 알아?"에 대한 답변은 없으므로, 문맥은 생일이 공개되지 않았다는 올바른 판단을 내리기에
- `codex` — PASS (12475ms): 컨텍스트에는 사용자가 다음주가 생일이라고만 말했을 뿐 정확한 날짜는 전혀 없으므로 생일을 모른다고 답해야 한다.
- `gemini` — PASS (14961ms): The context only mentions the birthday is 'next week' without disclosing a specific date, which supports the requirement for the agent to abstain from providing a precise day.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21240ms): 사용자가 생일을 알려준 적 없음
- `opencode` — PASS (10593ms): 컨텍스트에서 사용자가 "다음주 생일"이라고만 언급했고 구체적인 날짜는 제공된 적 없으므로, 에이전트는 생일 날짜를 모른다고 정확히 응답할 수 있다.
- `codex` — PASS (8318ms): 컨텍스트에는 사용자가 다음주가 생일이라고만 말했을 뿐 정확한 날짜를 알려준 적이 없으므로 모른다고 답해야 한다.
- `gemini` — PASS (12761ms): The context shows the user only mentioned their birthday is next week (다음주) without providing a specific date, which allows the agent to correctly conclude that the exact date was never disclosed.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15904ms): The context shows the user mentioned their birthday is next week but didn't provide the specific date, and the user is asking if the assistant knows the date.
- `opencode` — PASS (12594ms): 컨텍스트에서는 "다음주 생일"이라고만 언급하고 구체적인 날짜는 제공되지 않았으므로, 에이전트가 정확하게 기권하는 데 충분한 정보를 가지고 있습니다.
- `codex` — PASS (6398ms): CONTEXT states only that the birthday is next week and never gives an actual date, so the agent has enough information to correctly abstain with 모름 or 제공된 정보 없음.
- `gemini` — PASS (17519ms): 대화 내용에 생일이 '다음주'라는 언급은 있으나 정확한 날짜는 제공되지 않았으므로 기준에 따른 적절한 기권(abstain)이 가능합니다.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (22417ms): The context only mentions the user's birthday is "next week" without providing a specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — FAIL (14431ms): 사용자가 "다음주 생일"이라고만 언급했고, 정확한 날짜는 제공하지 않았지만, 컨텍스트는 이 사실을 포함하고 있으며 이에 대해 금주하도록 요구하는 기준을 충족하지만, 질문은 사용자의 생일이 언제인지 알고 있는지를 묻고 있으며, 컨텍스트는 에이전트가 생일 날짜를 알지 못한다는 것을 보여줍니다. — 하지만 실제로 핵심은 다음과 같습니다: 컨텍스트는 사용자가 생일
- `codex` — PASS (7108ms): 컨텍스트에는 사용자가 다음주 생일이라고만 말했을 뿐 정확한 날짜를 알려준 적이 없으므로 모른다고 답해야 한다.
- `gemini` — PASS (17971ms): The context includes a mention that the user's birthday is next week but provides no specific date, which is consistent with the requirement to abstain.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
