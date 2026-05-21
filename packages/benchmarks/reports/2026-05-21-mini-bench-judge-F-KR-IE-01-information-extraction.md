# Mini-bench (judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-21

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `reactive-vercel` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (22034ms): Context accurately lists allergies (nuts—walnuts/cashews, shrimp) and confirms seeds are non-allergic, with no misclassification of preferences or health factors as allergies.
- `opencode` — PASS (8904ms): Discoveries에 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"가 명시되어 있고, 씨앗은 괜찮다고 확인되었으며 수면·카페인·채소 호불호는 알레르기와 무관한 별도 항목으로 기록되어 기준을 충족함.
- `codex` — PASS (13530ms): Context explicitly states the allergies are 견과류 특히 호두와 캐슈넛 and 새우, and separately states 씨앗은 괜찮아요 while other items like 채소 기호, 수면, 카페인 are clearly discussed as non-allergy factors.
- `gemini` — PASS (14358ms): 컨텍스트 내 Discoveries와 대화 내용에 견과류(호두, 캐슈넛) 및 새우 알레르기와 씨앗, 채소 선호도, 카페인 등의 비알레르기 항목이 모두 명확히 기술되어 있습니다.

### `reactive-vercel`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (8496ms): Context accurately lists allergies (nuts/shrimp) and excludes them from recommendations while correctly identifying seeds as non-allergenic.
- `opencode` — FAIL (6342ms): CONTEXT가 "[context truncated by provider]"로 시작되어 알레르기 항목(견과류, 새우)이 처음 언급된 초기 대화가 누락되었으며, 남은 부분에서는 알레르기에 대한 간접적인 언급만 있을 뿐 이를 완전하게 나열할 수 없습니다.
- `codex` — FAIL (9355ms): 문맥에는 견과류 알레르기와 새우 제외, 씨앗은 괜찮다는 점만 있고 견과류의 구체 항목인 호두와 캐슈넛이 보이지 않아 모든 알레르기 항목을 정확히 복원할 수 없습니다.
- `gemini` — FAIL (36781ms): 사용자의 알레르기 항목 중 견과류(호두, 캐슈넛)에 대한 구체적인 언급이 컨텍스트에 포함되어 있지 않아 정확한 나열이 불가능합니다.

### `realtime`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (48192ms): Context accurately lists allergies (nuts—walnuts/cashews, shrimp) and confirms non-allergens (seeds, vegetable preferences, sleep, caffeine) are not misclassified as allergies.
- `opencode` — PASS (10208ms): Discoveries에 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"가 명시되어 있고, 대화에서 씨앗은 "괜찮아요"로 확인되어 알레르기가 아닌 항목과의 구분이 가능하다.
- `codex` — PASS (35865ms): Context explicitly states the allergies as nuts especially walnuts and cashews and shrimp, and it also says seeds are okay while vegetable dislike, sleep, and coffee/caffeine are presented as preferen
- `gemini` — PASS (13635ms): Context explicitly identifies nuts (walnuts, cashews) and shrimp as allergies, while clarifying that seeds are safe and noting vegetable dislike, caffeine, and sleep as non-allergy factors.

### `anthropic-native`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (32154ms): The context accurately identifies nuts and shrimp as allergies, and correctly identifies seeds, vegetables, sleep issues, and caffeine as non-allergy items.
- `opencode` — FAIL (19631ms): 견과류 알레르기와 새우 알레르기는 context에 나타나지만, PASS CRITERION이 요구하는 구체적 견과류 품목(호두, 캐슈넛)이 context에 전혀 언급되지 않아 — truncation(1184/1517 chars)으로 초기 turn의 상세 알레르기 정보가 유실된 것으로 보임.
- `codex` — FAIL (10766ms): 문맥에는 견과류 알레르기와 씨앗은 괜찮다는 정보만 직접 보이고 새우 알레르기 및 견과류 중 특히 호두와 캐슈넛이라는 구체 항목이 빠져 있어 모든 알레르기 항목을 정확히 나열할 근거가 부족합니다.
- `gemini` — FAIL (29110ms): The provided context lacks the specific mentions of walnuts and cashews required by the pass criterion, although it does identify nuts and shrimp as allergies and correctly notes non-allergy items lik

### `off`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (21720ms): CONTEXT accurately lists nuts (implied walnuts/cashews) and shrimp as allergies, and correctly identifies seeds, vegetable preferences, sleep, and caffeine as non-allergies without misclassification.
- `opencode` — FAIL (21711ms): 컨텍스트에는 일반적인 견과류(견과류) 알레르기와 새우 제외만 나와 있으며, 자른 부분에 있었을 수 있는 특정 견과류인 호두(호두)와 캐슈넛(캐슈넛)에 대한 구체적인 언급이 없어 에이전트가 PASS CRITERION을 충족할 수 없습니다.
- `codex` — FAIL (11416ms): 문맥에는 견과류 알레르기와 새우 제외는 보이지만 호두와 캐슈넛이라는 구체 항목이 없어서 모든 알레르기 항목을 정확히 나열할 근거가 부족합니다.
- `gemini` — FAIL (46031ms): The context mentions general nuts and shrimp allergies, but the specific items "walnuts" and "cashews" required by the pass criterion were truncated and are not present.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
