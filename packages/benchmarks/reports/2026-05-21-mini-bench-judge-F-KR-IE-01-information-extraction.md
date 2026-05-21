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
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15328ms): The context accurately lists all allergy items (nuts - especially walnuts and cashews, shrimp) and correctly identifies seeds as non-allergic items while distinguishing other dietary preferences from 
- `opencode` — PASS (13571ms): 컨텍스트의 발견 사항 섹션에 명시적으로 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"라고 명시되어 있으며, 후속 대화에서 씨앗이 안전하다고 확인되었고("씨앗은 괜찮아요"), 채소는 취향 문제, 카페인과 수면은 건강 관심사로 별개로 다루어졌습니다.
- `codex` — PASS (7835ms): CONTEXT explicitly states the user's 알레르기 is 견과류(특히 호두, 캐슈넛)와 새우 and separately states 씨앗은 괜찮고 채소 호불호·수면·카페인 관련 내용은 있어도 알레르기로 분류되지 않아 criterion을 충족합니다.
- `gemini` — PASS (13275ms): Discoveries 섹션에 견과류(호두, 캐슈넛)와 새우가 알레르기로 명시되어 있고, 대화 내용에서 씨앗은 괜찮다는 확인과 채소는 단순 불호라는 점이 명확히 기록되어 있습니다.

### `reactive-vercel`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11052ms): Context accurately lists all allergies (nuts: walnuts/cashews, shrimp) and correctly classifies non-allergy items (coffee, sleep, family history, activity) as non-allergies.
- `opencode` — PASS (11265ms): 컨텍스트는 사용자의 견과류(호두, 캐슈넛) 및 새우 알레르기를 명확하게 기록하며, 비알레르기 항목(커피/카페인, 수면 문제, 가족력, 체중)은 알레르기로 오분류하지 않습니다.
- `codex` — PASS (10120ms): CONTEXT explicitly states severe nut allergy, especially walnuts and cashews, plus shrimp allergy, and the other mentioned items like coffee intake and sleep issues are clearly presented as non-allerg
- `gemini` — PASS (13424ms): 사용자의 견과류(호두, 캐슈넛) 및 새우 알레르기와 카페인 섭취, 당뇨 가족력 등 알레르기가 아닌 식이 관련 정보가 컨텍스트에 모두 명시되어 있습니다.

### `realtime`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (25414ms): CONTEXT accurately lists allergies (nuts—walnuts/cashews, shrimp) and correctly excludes non-allergies (seeds, vegetable dislikes, sleep, caffeine) from allergy classification.
- `opencode` — PASS (17981ms): Discoveries에 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"가 명시되어 있고, 대화 꼬리에서 씨앗이 괜찮음을 확인("씨앗은 괜찮아요")하며 채소·수면·카페인은 알레르기가 아닌 별개 주제로만 다뤄져 비-알레르기 항목 오분류 가능성이 없습니다.
- `codex` — PASS (7552ms): 컨텍스트에 견과류 알레르기(특히 호두, 캐슈넛)와 새우 알레르기가 명시되어 있고 씨앗은 괜찮다고 되어 있어 씨앗·채소 호불호·수면·카페인을 알레르기로 오분류하지 않고 구분할 수 있습니다.
- `gemini` — PASS (11389ms): The context explicitly identifies nuts (specifically walnuts and cashews) and shrimp as allergies, while clarifying that seeds are safe and noting other non-allergy factors like vegetable dislike and 

### `anthropic-native`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14617ms): CONTEXT contains all allergy items (nuts—specifically walnuts and cashews, shrimp) and correctly identifies non-allergy items (seeds, vegetable preferences, sleep issues, caffeine) without misclassifi
- `opencode` — PASS (11975ms): CONTEXT에는 알레르기 항목(견과류 — 호두·캐슈넛, 새우)이 명시되어 있고, 씨앗은 "괜찮아요"로 알레르기가 아님이 확인되었으며, 채소 호불호·카페인·수면은 알레르기와 무관한 정보로만 등장합니다.
- `codex` — PASS (6480ms): 문맥에 사용자의 알레르기가 견과류(특히 호두와 캐슈넛)와 새우라고 명시되어 있고, 씨앗은 괜찮다고 했으며 채소 호불호·수면 문제·커피 섭취는 알레르기가 아닌 별도 정보로 구분되어 있어 기준을 충족합니다.
- `gemini` — PASS (12966ms): 컨텍스트에 견과류(호두, 캐슈넛)와 새우가 알레르기 항목임이 명시되어 있고, 씨앗은 괜찮다는 확인과 채소는 불호 항목임이 명확히 구분되어 기록되어 있습니다.

### `off`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (24859ms): The context accurately lists all allergies (nuts—specifically walnuts and cashews, shrimp) and correctly identifies non-allergy items (seeds, vegetable preferences, sleep, caffeine) without misclassif
- `opencode` — **INFRA** (13404ms): opencode reply unparseable (145 chars): 통과: 컨텍스트는 명확하게 모든 알레르기 항목(견과류 — 특히 호두와 캐슈넛, 새우)을 식별하고, 씨앗류를 명시적으로 알레르기가 아닌 것으로 확인("씨앗은 괜찮아요")하며, 채소 호불호, 수면 문제, 카페인 섭취를 
- `codex` — PASS (7972ms): Context explicitly states severe nut allergy especially walnuts and cashews plus a shrimp allergy, and also clarifies seeds are okay while vegetable dislike, sleep issues, and coffee intake are not al
- `gemini` — PASS (14133ms): 컨텍스트 내에 사용자의 알레르기(견과류, 특히 호두/캐슈넛, 새우)와 알레르기가 아닌 항목(씨앗, 채소 불호, 커피 등)이 명확히 구분되어 기록되어 있다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
