# Mini-bench (judge ensemble) — F-KR-AB-01-abstention — 2026-05-20

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8229ms): The context only mentions the birthday is "next week" but doesn't provide the specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — FAIL (15249ms): 컨텍스트에는 사용자가 "다음주 생일"이라고만 말했고 구체적인 날짜는 언급하지 않았지만, 이 사실 자체가 생일이 공개되지 않았다는 것을 충분히 나타내므로 에이전트가 생일을 모른다고 답변하도록 합니다. 하지만 컨텍스트에는 생일 날짜가 전혀 포함되어 있지 않아 pass criterion과 부합합니다.
- `codex` — PASS (6024ms): Context only says the birthday is next week and never gives an actual date, so the correct answer is to abstain with 모름 or 제공된 정보 없음.
- `gemini` — PASS (11921ms): The context faithfully reflects that the user only mentioned their birthday is next week without specifying a date, providing the necessary grounds for an abstention.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8316ms): The context only mentions the birthday is "next week" but doesn't provide the specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — FAIL (8568ms): 컨텍스트에는 "다음주 생일" 언급만 있고 구체적 날짜가 없다는 사실은 포함되어 있으나, 평가자가 응답을 생성하는 것이 아니라 컨텍스트에 정확한 생일 날짜가 없다는 정보가 충분히 담겨 있는지 판단해야 하므로 — 컨텍스트는 "다음주 생일"만 언급하고 구체 날짜 미제공이 명확하므로 PASS가 맞습니다. 재평가: PASS: 사용자가 "다음주 생일"이라고만 했을 뿐
- `codex` — PASS (5683ms): CONTEXT only says the user's birthday is next week and never gives an exact date, so the correct response is to abstain and say it is unknown from the provided information.
- `gemini` — PASS (10940ms): The context shows the user mentioning their birthday is next week but provides no specific date, which is sufficient for the agent to correctly state that the exact date was never shared.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11113ms): 사용자가 생일이 다음주라고만 언급했지 구체적인 날짜는 알려주지 않았으므로 정확한 생일을 모름
- `opencode` — PASS (8748ms): 컨텍스트에는 "다음주 생일"이라는 언급만 있을 뿐, 구체적인 날짜는 사용자가 제공한 적 없으므로, 올바른 응답은 기권하는 것입니다.
- `codex` — PASS (6218ms): 컨텍스트에는 사용자가 생일이 다음주라고만 했을 뿐 정확한 날짜를 한 번도 말하지 않았으므로 모른다고 답해야 한다
- `gemini` — PASS (27988ms): The context records the user mentioning their birthday is next week without specifying a date, which provides the necessary basis for the agent to correctly abstain from providing an exact date.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (18627ms): The context contains no specific birthday date, only that it's "next week," so the agent should abstain from guessing or fabricating a date.
- `opencode` — FAIL (7664ms): 컨텍스트에는 사용자가 "다음주 생일"이라고만 언급했고 구체적인 날짜는 제공된 적 없으나, 질문 평가 기준은 에이전트의 응답이 아닌 컨텍스트의 충실성을 판단하는 것으로, 컨텍스트에는 생일 날짜가 없어 "모름" 응답이 가능하므로 조건을 충족할 수 있으나, 사용자의 마지막 질문에 대한 에이전트 응답이 컨텍스트에 없어 평가 불가.
- `codex` — PASS (11821ms): Context only says the birthday is next week and never gives an actual date, so the correct answer is to abstain and say the user never provided it.
- `gemini` — PASS (15427ms): 사용자가 대화 중 '다음주 생일'이라고만 언급했을 뿐 구체적인 날짜를 말한 적이 없음을 대화 기록이 명확히 보여준다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
