# Mini-bench (judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-20

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (49824ms): CONTEXT contains confirmed nut allergy (견과류), shrimp exclusion (새우 제외), and confirms seeds are safe (씨앗 괜찮아요) without misclassifying preferences as allergies.
- `opencode` — FAIL (12258ms): CONTEXT는 '견과류'와 '새우' 알레르기만 언급하며, 구체적 견과류 종류(호두, 캐슈넛)가 컴팩션 과정에서 누락되어 전체 알레르기 항목을 정확히 나열하기에 불충분하다.
- `codex` — FAIL (7594ms): CONTEXT only supports 견과류 알레르기, 새우 제외, 씨앗은 괜찮음 정도이며 호두와 캐슈넛이라는 구체 항목이 없어 모든 알레르기 항목을 정확히 나열할 근거가 부족합니다.
- `gemini` — FAIL (16886ms): The context identifies nuts and shrimp as allergies but lacks the specific mention of walnuts and cashews required by the pass criterion.

### `realtime`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (8627ms): CONTEXT lacks explicit allergy summary; only scattered mentions (견과류, 새우) without consolidated list.
- `opencode` — FAIL (8514ms): CONTEXT는 견과류(특히 호두, 캐슈너트)와 새우 알레르기를 암시하지만, 어떤 견과류인지 명시적으로 명시하지 않으며, 새우 알레르기가 언급된 이전 대화 부분은 대화의 마지막 turn에서 견과류 알레르기가 암시되고 새우가 제외된 저녁 추천에서 간접적으로만 추론될 수 있습니다.
- `codex` — FAIL (7045ms): CONTEXT only supports general 견과류 allergy and 새우 exclusion plus 씨앗은 괜찮다는 non-allergy detail, but it omits the required specific 항목인 호두와 캐슈넛 so the agent lacks enough faithful information to list all a
- `gemini` — FAIL (12445ms): The context lacks the specific allergy details for walnuts and cashews that are required by the pass criterion, only mentioning nuts and shrimp generally.

### `anthropic-native`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (24506ms): The context accurately lists the user's allergies as nuts (specifically walnuts and cashews) and shrimp, and correctly identifies seeds as non-allergenic.
- `opencode` — PASS (7305ms): CONTEXT에 사용자의 알레르기 항목이 명확히 기록되어 있습니다: 견과류(호두, 캐슈넛)와 새우, 그리고 씨앗은 괜찮다고 확인되어 비알레르기 항목과의 구분도 가능합니다.
- `codex` — PASS (6336ms): 문맥에 사용자의 알레르기가 견과류 알레르기(특히 호두와 캐슈넛은 절대 금지)와 새우 알레르기로 명시되어 있고, 씨앗은 괜찮다고 따로 확인되어 있어 비알레르기 항목을 구분할 수 있습니다.
- `gemini` — PASS (11127ms): The context explicitly records the user stating they have a severe nut allergy (walnuts and cashews) and a shrimp allergy, while also confirming that seeds are fine.

### `off`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (19000ms): CONTEXT accurately lists all allergies (nuts—specifically walnuts and cashews, shrimp) and correctly excludes seeds as non-allergenic.
- `opencode` — **INFRA** (8606ms): opencode reply unparseable (181 chars): 통과: 컨텍스트는 "견과류 알레르기가 심합니다. 특히 호두랑 캐슈넛은 절대 안 됩니다. 그리고 새우도 알레르기 있어요"라고 사용자가 명시적으로 진술하고, 보조가 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"로 확인
- `codex` — PASS (5712ms): Context explicitly states severe nut allergy with walnuts and cashews absolutely forbidden plus a shrimp allergy, and also separately clarifies seeds are okay so non-allergy items are not misclassifie
- `gemini` — PASS (9056ms): The context contains the user's explicit statement identifying allergies to nuts (specifically walnuts and cashews) and shrimp, as well as confirmation that seeds are safe.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
