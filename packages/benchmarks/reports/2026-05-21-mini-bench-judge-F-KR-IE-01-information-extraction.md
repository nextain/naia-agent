# Mini-bench (judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-21

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `reactive-vercel` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (17541ms): Context lacks specific mention of walnuts and cashews, only general "nuts" allergy is confirmed.
- `opencode` — FAIL (14369ms): 압축된 컨텍스트는 견과류 알레르기를 일반적으로만 언급하며, 특정한 견과류인 호두와 캐슈넛은 손실되었고, 기준에서 이를 올바르게 나열해야 한다고 요구합니다.
- `codex` — FAIL (8578ms): 문맥에는 견과류 알레르기와 새우 제외, 씨앗은 괜찮다는 정보만 있고 PASS 기준에 필요한 호두와 캐슈넛의 구체적 명시가 없어 모든 알레르기 항목을 정확히 재진술할 근거가 부족합니다.
- `gemini` — FAIL (25815ms): The context lacks the specific allergy details for walnuts and cashews required by the pass criterion, providing only a general mention of nuts and shrimp.

### `reactive-vercel`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (20358ms): CONTEXT accurately lists nuts and shrimp as allergies while confirming seeds are safe and no non-allergy items are misclassified.
- `opencode` — FAIL (15155ms): Context는 견과류 알레르기와 새우 제외를 보여주지만, 호두와 캐슈넛이라는 구체적인 견과류 종류는 전혀 언급되지 않아, 패스 기준에서 요구하는 정확한 열거가 불가합니다.
- `codex` — FAIL (7465ms): CONTEXT only supports a general nut allergy and shrimp exclusion plus that seeds are okay, but it does not faithfully preserve the exact allergy list with especially walnuts and cashews, so the agent 
- `gemini` — FAIL (18307ms): The context identifies the categories of nuts and shrimp but omits the specific details of walnuts and cashews required to satisfy the pass criterion.

### `realtime`

**Probe 1** (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (12380ms): Context accurately lists allergies to nuts (specifically walnuts and cashews) and shrimp, correctly excludes seeds as safe, and doesn't misclassify non-allergy items.
- `opencode` — FAIL (12892ms): 컴팩션된 컨텍스트는 "견과류 알레르기"와 "새우 제외"를 포함하고 있지만, 요구되는 구체적인 견과류 종류인 호두와 캐슈넛은 이전 대화 턴에서 유실되었으며, 컨텍스트에 언급되지 않았습니다.
- `codex` — FAIL (12058ms): 문맥에는 견과류와 새우만 간접적으로 드러나고 견과류 중 특히 호두와 캐슈넛이라는 정확한 항목이 없어서 PASS 기준의 모든 알레르기 목록을 충족하지 못합니다.
- `gemini` — FAIL (13217ms): The context mentions nuts and shrimp generally but lacks the specific details about walnuts and cashews required by the pass criterion.

### `anthropic-native`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (18815ms): Context accurately lists all allergies (nuts—especially walnuts/cashews, shrimp) and correctly excludes non-allergies (seeds, vegetable preferences, sleep, caffeine).
- `opencode` — PASS (13308ms): 컨텍스트는 사용자가 명시적으로 견과류(호두, 캐슈넛)와 새우 알레르기가 있다고 진술하고(그리고 어시스턴트가 이를 확인함), 씨앗은 괜찮다고 명확히 확인하며, 수면/카페인/채소 취향을 알레르기로 분리하여 유지합니다.
- `codex` — PASS (9211ms): Context explicitly states severe nut allergy with walnuts and cashews absolutely forbidden plus a shrimp allergy, and separately notes seeds are okay so non-allergy items are not confused as allergies
- `gemini` — PASS (15457ms): 컨텍스트 내에 사용자가 명시한 견과류(호두, 캐슈넛) 및 새우 알레르기 정보와 씨앗류는 괜찮다는 사실이 모두 정확하게 포함되어 있습니다.

### `off`

**Probe 1** (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13006ms): The context accurately lists the user's allergies as nuts (specifically walnuts and cashews) and shrimp, and correctly excludes seeds as non-allergenic.
- `opencode` — PASS (9989ms): 컨텍스트는 사용자의 알레르기를 명시적으로 나열합니다 — 견과류(특히 호두, 캐슈넛)와 새우 — 그리고 씨앗이 괜찮다고 명시하여 비알레르기 항목을 명확히 구분합니다.
- `codex` — PASS (13744ms): 문맥에 사용자의 알레르기가 견과류 알레르기이며 특히 호두와 캐슈넛은 절대 안 되고 새우도 알레르기라고 명시되어 있고, 씨앗은 괜찮다고 확인되어 비알레르기 항목과 구분할 수 있습니다.
- `gemini` — PASS (10977ms): The context explicitly mentions the user's allergies to nuts (specifically walnuts and cashews) and shrimp, while also confirming that seeds are not an allergy.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
