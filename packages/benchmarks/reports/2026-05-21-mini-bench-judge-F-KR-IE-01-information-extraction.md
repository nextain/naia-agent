# Mini-bench (judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-21

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `reactive-vercel` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (23891ms): The context accurately lists the user's allergies (nuts - especially walnuts and cashews, shrimp) and correctly identifies seeds as non-allergens without misclassifying other items.
- `opencode` — PASS (17827ms): Discoveries에 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"가 명시되어 있고, 대화에서 "씨앗은 괜찮아요"로 비알레르기 항목이 구분되어 있어 모든 알레르기·비알레르기 정보가 충실하게 보존되어 있다.
- `codex` — PASS (7970ms): 컨텍스트에 견과류 알레르기(특히 호두·캐슈넛)와 새우 알레르기가 명시되어 있고 씨앗은 괜찮다고 되어 있어 비알레르기 식이 항목을 알레르기로 오분류하지 않을 근거도 충분합니다.
- `gemini` — PASS (15275ms): The context explicitly identifies nuts (walnuts, cashews) and shrimp as allergies in the Discoveries section and clarifies that seeds are safe in the dialogue, while distinguishing caffeine and sleep 

### `reactive-vercel`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — FAIL (22848ms): CONTEXT lacks the final summarized list of allergies; only initial mentions exist without the promised consolidated response.
- `opencode` — **INFRA** (11305ms): opencode reply unparseable (232 chars): 우)과 비알레르기 항목(씨앗, 커피, 수면 문제, 당뇨 가족력, 활동 수준)이 모두 포함되어 있지만, 사용자의 질문은 또한 비알레르기 식이 항목(예: 사용자가 먹거나 피하는 음식이지만 알레르기가 아닌 것)을 명시적으
- `codex` — PASS (12394ms): CONTEXT explicitly states the user's allergies as 견과류(특히 호두, 캐슈넛) and 새우, and nothing else in the retained context is identified as an allergy, so non-allergy items are not forced into that category.
- `gemini` — PASS (15460ms): 대화 내용에 사용자의 알레르기(견과류-호두, 캐슈넛, 새우)와 식이 관련 정보(커피 3-4잔, 해바라기씨/호박씨 권장)가 명확히 기록되어 있어 기준을 충족합니다.

### `realtime`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12511ms): The context accurately lists the user's allergies (nuts - especially walnuts and cashews, shrimp) and correctly identifies seeds as non-allergens without misclassifying other dietary items as allergie
- `opencode` — PASS (13760ms): 컨텍스트의 'Discoveries' 섹션은 견과류(호두, 캐슈넛)와 새우 알레르기를 명시적으로 명시하고, 이후 대화에서는 씨앗이 괜찮다고 확인하며(알레르기가 아님을 명확히 함), 식단, 활동, 수면, 카페인에 대한 논의는 별개의 주제로 유지되어 알레르기로 오분류하지 않습니다.
- `codex` — PASS (7701ms): 문맥에 견과류(특히 호두·캐슈넛)와 새우 알레르기가 명시되고 씨앗은 괜찮다고 구분되어 있어, 알레르기 항목과 비알레르기 식이 항목을 혼동 없이 정확히 나열할 수 있습니다.
- `gemini` — PASS (14128ms): Discoveries 섹션에서 견과류(호두, 캐슈넛)와 새우를 알레르기로 명시하고 있으며, 대화 로그에서 씨앗류는 괜찮다는 사실과 카페인 섭취 정보를 포함하고 있어 항목 구분이 가능합니다.

### `anthropic-native`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (28777ms): The context accurately identifies allergies to nuts and shrimp while confirming seeds, vegetables, sleep issues, and caffeine are not allergies.
- `opencode` — FAIL (18279ms): The retained context only mentions 견과류 generically and implicitly excludes 새우 from meals, but the specific nut types (호두, 캐슈넛) and the explicit allergy declaration for 새우 were lost in the truncated 33
- `codex` — FAIL (13756ms): 문맥에는 견과류 알레르기와 새우 제외는 보이지만 호두와 캐슈넛이라는 구체 항목이 없어서 모든 알레르기 항목을 정확히 나열할 만큼 충분하지 않습니다.
- `gemini` — FAIL (15957ms): The context identifies nuts and shrimp as allergies and seeds as safe, but it lacks the specific mention of walnuts and cashews required by the pass criterion.

### `off`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (16947ms): Context accurately lists nuts (including walnuts/cashews) and shrimp as allergies, and correctly identifies seeds, vegetable preferences, sleep, and caffeine as non-allergies.
- `opencode` — FAIL (19100ms): 컨텍스트는 일반적인 견과류 알레르기를 언급하지만, 호두와 캐슈넛을 구체적으로 명시하지 않으며 (원래 공개 내용이 잘림), 새우는 '제외됨'으로만 암시되어 명시적인 알레르기 항목으로 명확하게 기술되지 않았습니다.
- `codex` — FAIL (7938ms): CONTEXT only supports nut allergy in general and shrimp exclusion plus seeds being okay, but it does not faithfully include the required specific walnut and cashew allergies and could not distinguish 
- `gemini` — FAIL (18121ms): The context mentions nuts and shrimp as allergies and seeds as safe, but lacks the specific identification of walnuts and cashews required by the pass criterion.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
