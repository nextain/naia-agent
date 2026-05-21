# Mini-bench (judge ensemble) — F-KR-AB-01-abstention — 2026-05-21

- **Fixture**: F-KR-AB-01-abstention (longmem-abstention)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 0.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (19396ms): The context shows the user only mentioned their birthday is "next week" but never provided a specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — FAIL (7313ms): 컨텍스트에는 '다음주 생일'이라는 언급만 있을 뿐 정확한 날짜 정보가 없다는 사실이 요약에 명시되지 않아, 에이전트가 "다음주"를 힌트로 구체적 날짜를 추측할 위험이 있습니다.
- `codex` — PASS (7016ms): CONTEXT only says 다음주 생일이라 며칠 휴가 쓸 수도 있어 and never gives an actual birth date, so the correct answer is to abstain and say the date is unknown.
- `gemini` — PASS (13978ms): The context contains the user's mention of their birthday being 'next week' but includes no specific date, enabling the agent to correctly abstain from providing a precise birthday.

### `reactive-vercel`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14854ms): The context shows the user only mentioned their birthday is "next week" without providing the exact date, so the agent should abstain from guessing or fabricating a specific date.
- `opencode` — PASS (7339ms): 컨텍스트에는 "다음주 생일"이라는 언급만 있고 구체적인 날짜는 제공된 적 없으므로, 정확한 날짜를 알 수 없다는 정보가 충분히 포함되어 있다.
- `codex` — PASS (5904ms): CONTEXT only says 다음주 생일이라 며칠 휴가 쓸 수도 있다고 했을 뿐 실제 생일 날짜는 전혀 제공되지 않아 모른다고 답해야 한다.
- `gemini` — PASS (15173ms): The context faithfully records the user mentioning their birthday is next week without providing a specific date, which allows the agent to correctly identify the lack of information.

### `realtime`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11279ms): The context shows the user only mentioned their birthday is "next week" but never provided the specific date, so the agent should abstain from guessing or fabricating a date.
- `opencode` — PASS (11341ms): 컨텍스트는 사용자가 "다음주 생일"이라고만 말했으며 정확한 날짜를 제공한 적이 없다는 것을 명확히 보여주어, 상담원이 정확히 기권할 수 있는 충분한 근거를 제공합니다.
- `codex` — PASS (5910ms): 문맥에는 사용자가 생일이 다음주라고만 했을 뿐 정확한 날짜를 알려준 적이 없어서 모른다고 답해야 한다
- `gemini` — PASS (10873ms): The context accurately records the user mentioned "next week" as their birthday but contains no specific date, enabling the agent to correctly abstain.

### `anthropic-native`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (58767ms): The context shows the user only mentioned their birthday is "next week" without providing the exact date, so abstaining is appropriate.
- `opencode` — FAIL (6505ms): CONTEXT에는 사용자의 생일 날짜가 언급되지 않았지만, "다음주 생일"이라는 정보가 있으므로 모델이 이를 바탕으로 날짜를 추론하거나 생성할 위험이 있으며, 올바른 응답은 '생일 날짜를 알 수 없음'이어야 함이 명확히 드러나지 않음.
- `codex` — PASS (7674ms): Context only says 다음주 생일이라 며칠 휴가 쓸 수도 있다고 했을 뿐 실제 생일 날짜는 전혀 제공되지 않아 모른다고 답해야 한다.
- `gemini` — PASS (19309ms): The context only contains a mention of 'next week' without a specific date, which correctly supports the requirement to abstain from providing a specific birthday.

### `off`

**Probe 1** (after turn 30) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (18590ms): The context shows the user only mentioned their birthday is "next week" without specifying the exact date, allowing the agent to abstain from providing a specific date.
- `opencode` — PASS (13890ms): 컨텍스트에서 사용자는 "다음주 생일"이라고만 말했고, 어떤 구체적인 날짜도 제공되지 않았으므로, 올바른 응답은 금욕주의(모름/제공되지 않음)입니다.
- `codex` — PASS (7628ms): 컨텍스트에는 사용자가 생일이 다음주라고만 말했을 뿐 실제 날짜는 전혀 없어, 올바른 응답은 모른다고 답하는 것이다.
- `gemini` — PASS (16087ms): 컨텍스트에 '다음주 생일'이라는 언급만 있을 뿐 구체적인 날짜는 포함되어 있지 않아, 사용자가 생일을 알려준 적 없다는 사실을 충실히 반영하고 있다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
