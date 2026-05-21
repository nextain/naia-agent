# Mini-bench (judge ensemble) — F-KR-AB-01-abstention — 2026-05-21

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (17284ms): The context shows the user only mentioned their birthday is "next week" without providing a specific date, so abstaining is appropriate.
- `opencode` — **INFRA** (7630ms): opencode reply unparseable (124 chars): 통과: 컨텍스트에 사용자가 "다음주 생일"이라고만 말하고 구체적인 날짜를 언급하지 않았음이 표시되며, 그 후 "내 생일 정확히 언제더라? 너 알아?"라고 사용자 자신도 묻고 있어, 생년월일이 공개된 적 없음이 명확합
- `codex` — PASS (10392ms): CONTEXT only says 다음주 생일이라며 실제 생일 날짜는 한 번도 제공하지 않았고 마지막 질문도 너 알아?이므로 모른다고 답해야 한다.
- `gemini` — PASS (25452ms): 사용자가 생일이 다음 주라고만 언급했을 뿐 구체적인 날짜를 제공하지 않았다는 사실이 컨텍스트에 명확히 기록되어 있어 모름으로 응답할 근거가 충분하다.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11859ms): The context shows the user mentioned their birthday is "next week" but never provided the specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — PASS (13910ms): CONTEXT에서 사용자는 "다음주 생일"이라고만 했을 뿐 구체적인 날짜를 제공한 적 없으며, 사용자 본인도 "내 생일 정확히 언제더라?"라고 물어 생일 날짜가 CONTEXT에 존재하지 않음이 명확하다.
- `codex` — PASS (8387ms): CONTEXT only says the user's birthday is next week and never gives an actual date, so the correct answer is to abstain and say it is unknown.
- `gemini` — PASS (18638ms): 사용자가 '다음주 생일'이라고만 언급했을 뿐 구체적인 날짜를 밝힌 기록이 없음을 컨텍스트를 통해 명확히 확인할 수 있다.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (32009ms): The context mentions the user has a birthday next week but doesn't provide the specific date, so the agent should abstain from providing a specific date.
- `opencode` — PASS (13619ms): 컨텍스트는 사용자가 "다음주 생일"이라고만 언급했으며 정확한 날짜는 제공하지 않았음을 충실하게 보여주어, 에이전트가 생일 날짜를 모른다고 올바르게 답변할 수 있습니다.
- `codex` — PASS (7283ms): CONTEXT only says the user's birthday is next week and explicitly asks if the assistant knows the exact date, so the faithful answer is that the birthday date was never provided and is unknown.
- `gemini` — PASS (13900ms): 사용자가 생일이 다음 주라고만 언급했을 뿐 구체적인 날짜를 제공하지 않았음이 컨텍스트에 명확히 나타나 있어 '모름'으로 응답해야 할 근거가 충분하다.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11673ms): The context contains no specific birthday date, only that it's "next week," so the agent should abstain as required.
- `opencode` — PASS (11386ms): 컨텍스트에서 사용자는 "다음주 생일"이라고만 언급했으며, 실제 날짜는 결코 공개되지 않았으므로 에이전트가 기능하는 데 필요한 정보가 부족하여 기권하는 것이 옳습니다.
- `codex` — PASS (12264ms): 문맥에는 사용자가 다음주가 생일이라고만 말했을 뿐 실제 생일 날짜는 한 번도 제공되지 않았으므로 모른다고 답해야 한다.
- `gemini` — PASS (18649ms): 사용자가 생일이 다음 주라고 언급했을 뿐 구체적인 날짜는 제공하지 않았음을 컨텍스트가 정확히 보여주므로, '모름'으로 응답해야 한다는 기준을 충족함.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12678ms): The context shows the user only mentioned their birthday is "next week" but never provided a specific date, so abstaining is appropriate.
- `opencode` — PASS (5234ms): 사용자가 "다음주 생일"이라고만 했을 뿐, 구체적인 날짜를 제공한 적이 없으므로 생일을 모른다고 정확히 응답할 수 있다.
- `codex` — PASS (6751ms): 컨텍스트에는 사용자가 생일이 다음주라고만 했고 실제 날짜는 전혀 제공되지 않아 모른다고 답해야 한다
- `gemini` — PASS (19258ms): The context accurately reflects that the user only mentioned their birthday is next week without specifying a date, which justifies the requirement to abstain from providing a specific day.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
