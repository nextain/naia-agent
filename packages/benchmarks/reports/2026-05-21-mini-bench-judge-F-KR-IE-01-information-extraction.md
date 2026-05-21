# Mini-bench (judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-21

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15405ms): The context accurately lists all allergy items (nuts - especially walnuts and cashews, shrimp) and correctly identifies non-allergy items (seeds, vegetable preferences, activity level, caffeine, sleep
- `opencode` — PASS (17349ms): Discoveries에서 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"를 명시하고, 대화에서 씨앗은 "괜찮아요"로 확인했으며 채소 호불호·수면·카페인은 알레르기와 무관한 별개 주제로 일관되게 구분되어 있음.
- `codex` — PASS (7414ms): 컨텍스트에 견과류(특히 호두, 캐슈넛)와 새우 알레르기가 명시되어 있고 씨앗은 괜찮다, 채소는 비선호, 수면 부족, 커피 3-4잔 등은 알레르기가 아닌 별도 정보로 구분되어 있어 기준을 충족합니다.
- `gemini` — PASS (14591ms): The context explicitly lists nuts (specifically walnuts and cashews) and shrimp as allergies and confirms that seeds, vegetable dislike, caffeine, and sleep are not allergies.

### `reactive-vercel`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10838ms): CONTEXT accurately lists all allergies (nuts—specifically walnuts/cashews, shrimp) and correctly identifies non-allergies (seeds, vegetable preferences, caffeine, sleep) without misclassification.
- `opencode` — FAIL (16464ms): 컨텍스트에는 모든 알레르기 정보(견과류-호두, 캐슈넛; 새우)와 비알레르기 항목(씨앗 OK, 채소 기호, 수면, 카페인)에 대한 충분하고 신뢰할 수 있는 정보가 포함되어 있지만, 마지막 사용자 메시지가 "내 알레르기가 정확히 뭐였더라? 다시 한 번만 정확히 말해줘요."로 끝나며, 이에 대한 어시스턴트의 응답이 누락되어 있어 기준에 부합하는 응답이 컨텍스트에
- `codex` — PASS (8390ms): 컨텍스트에 사용자가 견과류 알레르기(특히 호두와 캐슈넛)와 새우 알레르기가 있다고 명시되어 있고 씨앗은 괜찮다고 정정되어 있어 비알레르기 식이 항목을 알레르기로 오분류하지 않을 근거가 충분합니다.
- `gemini` — PASS (11569ms): 컨텍스트에 견과류(호두, 캐슈넛)와 새우 알레르기가 명시되어 있고, 씨앗은 괜찮다는 사실과 채소 비선호, 카페인 섭취 등의 비알레르기 항목 정보가 모두 포함되어 있다.

### `realtime`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13732ms): Context accurately lists allergies (nuts—walnuts/cashews, shrimp) and confirms seeds are safe, with no misclassification of non-allergy items.
- `opencode` — PASS (10543ms): Discoveries에 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"가 명시되어 있고, 후속 대화에서 씨앗은 괜찮음이 확인되었으며 채소 호불호·수면·카페인은 별개 항목으로 기록되어 알레르기 오분류 없이 모든 정보가 충실하게 보존됨.
- `codex` — PASS (7483ms): 컨텍스트에 사용자의 알레르기가 견과류(특히 호두, 캐슈넛)와 새우라고 명시되어 있고 씨앗은 괜찮다고 확인되어 있어 씨앗·채소 호불호·수면·카페인 등을 알레르기로 오분류하지 않고 정확히 구분할 수 있습니다.
- `gemini` — PASS (11619ms): CONTEXT specifies allergies to nuts (walnuts, cashews) and shrimp while explicitly confirming that seeds are safe and noting a dislike for vegetables without misclassifying them as allergies.

### `anthropic-native`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (26713ms): CONTEXT accurately lists nuts (including walnuts/cashews) and shrimp as allergies, and correctly identifies seeds, vegetable preferences, sleep issues, and caffeine as non-allergies.
- `opencode` — FAIL (17689ms): 컨텍스트 잘림으로 초기 턴이 유실되어 견과류 알레르기가 일반적으로만 언급되며, 구체적인 호두와 캐슈넛은 나타나지 않고 새우 알레르기는 파생된 언급에서만 추론할 수 있어 원래 사용자의 정확한 알레르기 목록에 대한 신뢰할 수 있는 정보가 부족합니다.
- `codex` — FAIL (8396ms): 문맥에는 견과류 알레르기와 새우 제외, 씨앗은 괜찮다는 정보만 있고 PASS 기준에 필요한 견과류의 구체 항목인 호두와 캐슈넛이 보이지 않아 모든 알레르기 항목을 정확히 열거할 근거가 부족합니다.
- `gemini` — FAIL (20374ms): The context contains information about general nut and shrimp allergies but completely lacks the specific mentions of walnuts (호두) and cashews (캐슈넛) required to satisfy the pass criterion.

### `off`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (25191ms): CONTEXT accurately lists allergies (nuts, shrimp) and excludes non-allergens (seeds, caffeine, sleep issues) from allergy classification.
- `opencode` — FAIL (18752ms): 컨텍스트에서 견과류 알레르기를 일반적으로만 언급하고 있으며 (호두와 캐슈넛의 구체적인 견과류 종류는 포함하지 않음), 이는 컨텍스트 잘림으로 인해 손실되었을 수 있으며, 새우 알레르기는 명시적으로 명시되지 않은 채 식사에서 제외된 것으로만 암시된다.
- `codex` — FAIL (8006ms): 문맥에는 견과류 알레르기와 새우 제외, 씨앗은 괜찮다는 정보만 있고 PASS 기준의 핵심인 특히 호두와 캐슈넛이 알레르기 항목이라는 구체 정보가 없어 모든 알레르기를 정확히 나열할 수 없습니다.
- `gemini` — FAIL (18658ms): The context lacks specific mention of walnut (호두) and cashew (캐슈넛), which are required by the pass criterion to accurately list all allergy items.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
