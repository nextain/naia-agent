# Mini-bench (R7 / judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-21

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: reactive, reactive-vercel, realtime, off
- **Probes**: 3 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 2 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 (n=1) | 0.500 (n=2) | n/a | no | 4.0 |
| `reactive-vercel` | 1.000 (n=1) | 0.500 (n=2) | n/a | no | 3.7 |
| `realtime` | 0.000 (n=1) | 0.500 (n=2) | n/a | no | 3.7 |
| `off` | 1.000 (n=1) | 0.500 (n=2) | n/a | no | 3.3 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (10064ms): Context explicitly lists allergies to nuts (walnuts/cashews) and shrimp, confirms seeds are safe, and shows no indication of vegetable allergies.
- `opencode` — FAIL (21460ms): 유지된 컨텍스트는 일반적인 견과류 알레르기와 새우 제외를 암시하지만, 특정 견과류 종류(호두, 캐슈넛)가 전혀 언급되지 않으며, 새우에 대한 알레르기는 사용자가 명시적으로 확인하지 않았고(제공자에 의해 잘림으로 인해 원래의 알레르기 목록이 손실됨), 원래 대화의 절반 이상이 잘려 있습니다.
- `codex` — FAIL (8349ms): Context only supports 견과류 알레르기, 새우 제외, 씨앗은 괜찮음, 채소 비선호 정도만 보이며 호두·캐슈넛 같은 구체 항목과 알레르기가 아닌 다른 식이 항목 전체를 정확히 열거할 정보가 부족합니다.
- `gemini` — FAIL (66664ms): The context mentions nuts and shrimp generally but lacks specific details about walnuts and cashews required by the pass criterion.

**Probe 2** [recap-only] (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (6091ms): Context contains no mention of family health history, specifically no reference to paternal diabetes or equivalent family history.
- `opencode` — FAIL (7632ms): 컨텍스트에 가족력에 대한 언급이 전혀 없으며, 아버지의 당뇨나 식단 관련 건강 위험에 대한 사실이 포함되어 있지 않습니다.
- `codex` — FAIL (9357ms): Context contains allergies, weight, and meal preferences but no family-history information such as 아빠가 당뇨, so the required answer is unsupported.
- `gemini` — FAIL (13660ms): The context contains information about weight, height, and allergies, but lacks any mention of the user's family history or the father's diabetes required by the criterion.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9956ms): Context explicitly states weight (73kg), height (174cm), and BMI (24.1) in the initial exchange.
- `opencode` — PASS (5942ms): 컨텍스트에 명시적으로 체중 73kg, 키 174cm, 그리고 계산된 BMI 24.1이 포함되어 있어, 세 가지 수치 모두가 제공되었습니다.
- `codex` — PASS (5695ms): Context explicitly states 체중 73kg and 키 174cm, and an earlier assistant turn gives BMI 24.1, so all three required values are available.
- `gemini` — PASS (25386ms): The context explicitly mentions weight as 73kg, height as 174cm, and BMI as 24.1.

### `reactive-vercel`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (68835ms): CONTEXT explicitly lists nuts (견과류) as prohibited, specifies walnuts and cashews in the criterion, excludes shrimp in meal suggestions, and confirms seeds (씨앗) are safe, while vegetable preferences, s
- `opencode` — FAIL (21031ms): 컨텍스트에는 견과류 알레르기와 새우 제외에 대한 일반적인 언급이 있지만, 트렁케이션된 부분에 포함된 구체적인 견과류 종류(호두, 캐슈넛)와 새우에 대한 명시적인 알레르기 분류가 누락되어, 에이전트는 정확한 목록을 제공할 수 없습니다.
- `codex` — FAIL (7106ms): Context supports 견과류 and 새우 allergy plus 씨앗은 괜찮아요, but it never states the required specific nut subitems 호두와 캐슈넛 and does not cleanly enumerate all non-allergy dietary items, so an exact answer canno
- `gemini` — FAIL (17441ms): The context is missing specific details about walnuts and cashews, which are required for a complete and accurate list of allergies according to the pass criterion.

**Probe 2** [recap-only] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (5997ms): Context explicitly states "아빠가 당뇨여서" when discussing family history, directly satisfying the criterion.
- `opencode` — **INFRA** (12781ms): opencode reply unparseable (125 chars): 통과: 맥락에 사용자의 발언인 "아빠가 당뇨여서"와 이에 대한 도우미의 "가족력 — 정제 탄수화물 줄이는 방향" 응답이 포함되어 있어, 당뇨와 관련된 식이 위험 요소로서 아버지의 당뇨 가족력을 명확하게 식별할 수 있
- `codex` — PASS (13441ms): Context explicitly states 아빠가 당뇨여서 저도 걱정이긴 해요, so an honest agent can clearly answer that the diet-related family-history risk factor is paternal diabetes/family history of diabetes.
- `gemini` — PASS (11012ms): 컨텍스트에 아빠가 당뇨여서 걱정이라는 사용자의 발언이 포함되어 있어 가족력 정보를 명확히 확인할 수 있습니다.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10579ms): Context explicitly states weight (73kg), height (174cm), and BMI (24.1) from user and assistant messages.
- `opencode` — PASS (8408ms): 컨텍스트에 체중 73kg, 키 174cm, BMI 24.1이 명시적으로 포함되어 있어 세 항목 모두 충족 가능합니다.
- `codex` — PASS (7255ms): Context explicitly states 체중 73kg and 키 174cm, and the assistant already computed BMI 24.1, which is sufficient to answer with all three required values.
- `gemini` — PASS (9627ms): The context explicitly states the user's weight as 73kg, height as 174cm, and BMI as 24.1.

### `realtime`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (10145ms): CONTEXT explicitly lists allergies (nuts - walnuts/cashews, shrimp) and confirms non-allergies (seeds, vegetable preferences) without misclassification.
- `opencode` — **INFRA** (24434ms): opencode reply unparseable (106 chars): 실패: 컨텍스트는 견과류 알레르기(일반적인)와 새우를 확인하지만, 기준에 따라 요구되는 특정 견과류 종류인 호두와 캐슈넛의 언급이 부족하여, 에이전트는 정확한 세부 정보를 알 수 없습니다.

- `codex` — FAIL (6208ms): CONTEXT only clearly establishes nut allergy and shrimp exclusion plus that seeds are tolerated, but it does not unambiguously provide the required specific nut items especially walnuts and cashews, s
- `gemini` — FAIL (30260ms): The context lacks specific mention of walnuts and cashews as nut allergies, and does not contain information about sleep or caffeine to correctly classify them as non-allergies as required by the crit

**Probe 2** [recap-only] (after turn 32) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (5995ms): Context contains no information about family health history, specifically no mention of paternal diabetes or equivalent.
- `opencode` — FAIL (12081ms): 컨텍스트에 사용자의 가족력이나 아버지의 당뇨병에 대한 정보가 전혀 포함되어 있지 않습니다. 모든 건강 관련 정보는 알레르기(견과류), BMI, 음식 선호도에 관한 것입니다.
- `codex` — FAIL (8368ms): 문맥에는 알레르기와 식단 추천만 있고 가족력이나 아빠의 당뇨 정보가 전혀 없어 요구된 답을 뒷받침할 수 없습니다.
- `gemini` — FAIL (15291ms): The provided context contains information about weight, BMI, and allergies (nuts, shrimp), but completely lacks any mention of family history or the father's diabetes.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8380ms): Context explicitly states weight (73kg), height (174cm), and BMI (24.1) in the initial exchange.
- `opencode` — PASS (10286ms): context에 "체중은 73kg, 키 174cm" 및 "BMI 24.1"이 명시되어 있어 세 가지 모두 충족함.
- `codex` — PASS (5984ms): Context explicitly states 체중 73kg and 키 174cm, and the assistant already computed BMI 24.1, so all required values are available.
- `gemini` — PASS (10863ms): The context explicitly states the user's weight is 73kg, height is 174cm, and the assistant calculates the BMI as 24.1.

### `off`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (14390ms): The context explicitly lists allergies (nuts—walnuts/cashews, shrimp) and confirms non-allergies (seeds), with no misclassification of preferences or health issues as allergies.
- `opencode` — FAIL (28527ms): Context confirms general 견과류 allergy but never specifies 호두 or 캐슈넛 by name, and 새우 is excluded by the assistant without explicit user confirmation of allergy — the truncated earlier context likely con
- `codex` — FAIL (8211ms): Context supports 견과류 알레르기와 새우 제외, 그리고 씨앗은 괜찮다는 점만 보이지만 호두와 캐슈넛이라는 구체 항목은 없어 모든 알레르기 항목을 정확히 나열할 근거가 부족합니다.
- `gemini` — **INFRA** (167367ms): gemini timed out after 90000ms

**Probe 2** [recap-only] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16499ms): The context explicitly states "아빠가 당뇨여서" (dad has diabetes), which is the diet-related family health risk factor.
- `opencode` — PASS (10171ms): CONTEXT에서 사용자가 "아빠가 당뇨여서"라고 명시했고, 어시스턴트도 "가족력 — 정기 혈당 체크 권장… 정제 탄수화물 줄이는 방향"이라고 응답하여, 부친 당뇨 가족력에 따른 식단 관련 건강 위험 요소를 명확히 도출할 수 있다.
- `codex` — PASS (12301ms): Context explicitly states 아빠가 당뇨여서 저도 걱정이라고 했으므로 식단과 관련된 가족력 위험 요소로 당뇨 가족력을 명확히 답할 수 있다.
- `gemini` — PASS (10095ms): 사용자가 아빠가 당뇨라는 사실을 직접 언급한 내용이 컨텍스트에 포함되어 있어 가족력 정보를 명확히 파악할 수 있다.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (8288ms): Context explicitly states weight 73kg, height 174cm, and BMI 24.1.
- `opencode` — **INFRA** (9497ms): opencode reply unparseable (85 chars): 통과: 컨텍스트에 명시적으로 "체중은 73kg, 키 174cm"라고 명시되어 있고 "BMI 24.1"이라고 계산되어 있어 세 가지 수치 모두 제공된다.

- `codex` — PASS (8359ms): Context explicitly states 체중 73kg, 키 174cm, and the assistant already computed BMI 24.1, so all required values are available unambiguously.
- `gemini` — PASS (9918ms): The context explicitly states the user's weight as 73kg, height as 174cm, and the assistant calculates the BMI as 24.1.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.