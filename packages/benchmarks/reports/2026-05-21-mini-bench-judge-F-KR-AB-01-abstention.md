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

- `glm` — PASS (40131ms): The context contains no specific birthday date, only that it's "next week," supporting an abstinent response.
- `opencode` — **INFRA** (10147ms): opencode reply unparseable (103 chars): 통과: 컨텍스트는 사용자가 "다음주 생일"이라고만 말했고 구체적인 날짜를 제공한 적이 없다는 것을 보여주므로, 상담원은 생일 날짜를 알 수 없다고 답변해야 한다는 것을 명확히 합니다.

- `codex` — PASS (10422ms): 컨텍스트에는 사용자가 다음주 생일이라고만 말했을 뿐 정확한 날짜는 전혀 없으므로 생일을 모른다고 답해야 한다.
- `gemini` — PASS (16296ms): 사용자가 다음 주가 생일이라는 사실만 언급했을 뿐 구체적인 날짜를 제공하지 않았음이 컨텍스트에 명확히 드러나 있어 모른다고 답변할 근거가 충분하다.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (19611ms): The context only mentions the birthday is "next week" without providing a specific date, so abstaining is appropriate.
- `opencode` — PASS (19750ms): 사용자가 '다음주 생일'이라고만 언급했을 뿐, 구체적인 날짜는 대화 전체에서 한 번도 공개되지 않았으므로, 올바른 응답은 생일 날짜를 모른다고 답하는 것입니다.
- `codex` — PASS (7721ms): Context only says the birthday is next week and never provides an actual date, so the agent should abstain with unknown/no information.
- `gemini` — PASS (18018ms): The context contains the user's mention of their birthday being next week but correctly omits any specific date, enabling the agent to abstain as required.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11103ms): The context mentions the user has a birthday next week but does not provide the specific date, so abstaining from providing a specific date is appropriate.
- `opencode` — PASS (9438ms): 컨텍스트에 '다음주 생일'이라고만 언급되어 있으며, 실제 날짜는 사용자가 제공한 적이 없습니다 — 구체적인 날짜를 제공할 충분한 정보가 없습니다.
- `codex` — PASS (8863ms): 컨텍스트에는 사용자가 다음주 생일이라고만 말했을 뿐 정확한 날짜는 전혀 없어서 모른다고 답해야 한다.
- `gemini` — PASS (10840ms): The context clearly shows the user mentioned having a birthday next week without specifying an exact date, which satisfies the requirement to abstain from providing a specific date.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13618ms): The context contains information that the user mentioned their birthday is next week but does not provide the specific date, so abstaining is appropriate.
- `opencode` — PASS (15487ms): CONTEXT에서 사용자는 "다음주 생일"이라고만 언급했고 구체적 날짜는 한 번도 제공하지 않았으므로, abstain(모름/제공된 정보 없음) 응답에 필요한 정보가 충분히 담겨 있다.
- `codex` — PASS (6976ms): Context only says the birthday is next week and explicitly lacks any actual date, so the correct response is to abstain and say the user never provided their exact birthday.
- `gemini` — PASS (12870ms): 컨텍스트에 '다음주 생일'이라는 언급은 있으나 구체적인 날짜는 포함되어 있지 않으므로, 기권(abstain) 응답을 유도하기에 충분한 정보가 포함되어 있다.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (24262ms): The context contains information that the user mentioned their birthday is next week but does not provide the specific date, so abstaining is appropriate.
- `opencode` — PASS (5510ms): 대화에서 사용자가 "다음주 생일"이라고만 언급했을 뿐 구체적인 생일 날짜를 제공한 적이 없으므로, 문맥에는 생일 날짜 정보가 포함되어 있지 않다.
- `codex` — PASS (8547ms): CONTEXT only says 다음주 생일이라 며칠 휴가 쓸 수도 있다고 했을 뿐 실제 생일 날짜는 전혀 제공되지 않아 모른다고 답해야 한다
- `gemini` — PASS (14769ms): 사용자가 생일이 다음주라고만 언급했을 뿐 구체적인 날짜를 밝히지 않았음을 컨텍스트가 명확히 보여주고 있습니다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
