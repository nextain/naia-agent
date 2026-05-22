# Mini-bench (R7 / judge ensemble) — F-KR-IE-01-information-extraction — 2026-05-22

- **Fixture**: F-KR-IE-01-information-extraction (longmem-information-extraction)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 3 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 3 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 1.000 (n=3) | n/a | no | 3.3 | 3985 | 449/287 |
| `hermes` | n/a | 1.000 (n=3) | n/a | no | 3.7 | 5820 | 835/353 |
| `reactive` | n/a | 1.000 (n=3) | n/a | no | 3.3 | 3 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=3) | n/a | no | 4.0 | 8316 | 384/193 |
| `off` | n/a | 1.000 (n=3) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (12183ms): Context clearly lists allergies (nuts—walnuts/cashews, shrimp) and distinguishes non-allergies (seeds, coffee, vegetable preference, sleep issues).
- `opencode` — **INFRA** (16364ms): opencode reply unparseable (155 chars): 통과: 컨텍스트에는 견과류(호두, 캐슈넛)와 새우에 대한 알레르기가 명시적으로 기록되어 있고, 씨앗류는 안전하다고 확인되었으며, 채소 기피, 수면 문제, 카페인은 알레르기가 아닌 선호도/상태로 명확하게 구분되어 있어
- `codex` — PASS (6163ms): Context explicitly states severe nut allergy especially walnuts and cashews plus shrimp allergy, and separately notes seeds are okay while vegetable dislike, sleep issues, and coffee intake are non-al
- `gemini` — PASS (12408ms): The context explicitly identifies nut (walnut, cashew) and shrimp allergies in the recap, and confirms seeds are safe while coffee and vegetables are preferences or habits in the tail.

**Probe 2** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (5135ms): Context explicitly states "아빠가 당뇨여서" (dad has diabetes) when discussing family history concerns.
- `opencode` — PASS (7472ms): CONTEXT의 tail에서 사용자가 "아빠가 당뇨여서 저도 걱정이긴 해요"라고 명시했고, 이에 대한 assistant 응답도 "가족력 — 정기 혈당 체크 권장"으로 당뇨 가족력을 확인.
- `codex` — PASS (6398ms): Tail context explicitly states 아빠가 당뇨여서 저도 걱정이긴 해요, which unambiguously supports answering that the diet-related family health risk is a paternal/family history of diabetes.
- `gemini` — PASS (9967ms): 컨텍스트의 tail 부분에 사용자가 아버지가 당뇨라고 언급한 대화 내용이 명확히 포함되어 있습니다.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (7038ms): Context explicitly states weight (73kg), height (174cm), and BMI (24.1) in the conversation.
- `opencode` — **INFRA** (16176ms): opencode reply unparseable (102 chars): 통과: 꼬리 부분에 "체중은 73kg, 키 174cm 입니다"라는 사용자 메시지와 "BMI 24.1"이라는 어시스턴트 응답이 포함되어 있어, 요청된 세 가지 수치 모두가 제공됩니다.

- `codex` — PASS (7044ms): Context explicitly states 체중 73kg, 키 174cm, and the assistant-calculated BMI 24.1, so an agent can answer with all three required values.
- `gemini` — PASS (10958ms): The context explicitly states the user's weight as 73kg, height as 174cm, and the assistant calculates the BMI as 24.1 in the conversation tail.

### `hermes`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12386ms): Context explicitly lists allergies to walnuts, cashews, and shrimp, and confirms seeds are not allergens, with no misclassification of non-allergy items.
- `opencode` — PASS (9371ms): 콘텍스트에 알레르기 항목(견과류 — 호두, 캐슈넛, 새우)이 명시적으로 기록되어 있고, 대화 꼬리에서 씨앗이 괜찮다고 확인되어 비알레르기 항목과의 혼동 없이 정확한 분류가 가능합니다.
- `codex` — PASS (7273ms): Context explicitly states the allergies are nuts especially walnuts and cashews plus shrimp, and it separately identifies seeds as safe and vegetables/caffeine/sleep as non-allergy context so an hones
- `gemini` — PASS (13335ms): 컨텍스트는 사용자의 알레르기 항목(호두, 캐슈넛, 새우)과 알레르기가 아닌 항목(씨앗, 채소 호불호, 카페인 선호 등)을 명확히 구분하여 제공한다.

**Probe 2** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (11843ms): The context contains the user's statement that "아빠가 당뇨여서" (dad has diabetes) and the assistant's acknowledgment of this as a family health history factor.
- `opencode` — **INFRA** (9813ms): opencode reply unparseable (93 chars): 통과: tail에서 사용자가 “아빠가 당뇨여서 저도 걱정이긴 해요”라고 명시하여 아버지의 당뇨 가족력이 식단 관련 건강 위험 요소로 문맥에 명확히 포함되어 있습니다.

- `codex` — PASS (6794ms): CONTEXT explicitly states 아빠가 당뇨여서 저도 걱정이긴 해요, so an agent can clearly answer that the family-history diet-related risk factor is paternal diabetes.
- `gemini` — PASS (11156ms): tail 섹션에서 사용자가 아빠가 당뇨라고 직접 언급한 사실이 포함되어 있어 부친 당뇨라는 가족력을 명확히 답변할 수 있습니다.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16385ms): Context includes user's stated weight (73kg), height (174cm), and assistant's calculated BMI (24.1).
- `opencode` — PASS (9102ms): 꼬리 부분에서 명시적으로 73kg 체중, 174cm 키, BMI 24.1을 제공합니다.
- `codex` — PASS (9754ms): Context explicitly states 체중 73kg and 키 174cm, and the assistant already computed BMI 24.1, so all required values are available unambiguously.
- `gemini` — PASS (9567ms): 대화 기록(tail)에 사용자가 직접 언급한 체중 73kg, 키 174cm와 어시스턴트가 계산한 BMI 24.1이 명시되어 있습니다.

### `reactive`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12386ms): Context explicitly lists allergies to nuts (walnuts, cashews) and shrimp, and clarifies seeds are safe while distinguishing dislikes (vegetables) from allergies.
- `opencode` — PASS (11742ms): Discoveries에 "견과류(특히 호두, 캐슈넛)와 새우 알레르기"가 명시되어 있고, tail 대화에서 씨앗은 "괜찮아요"로 확인되어 알레르기가 아닌 항목과의 구분이 가능합니다.
- `codex` — PASS (8902ms): Context explicitly states the user's allergies are nuts especially walnuts and cashews plus shrimp, and it separately states seeds are okay while vegetable dislike, sleep issues, and coffee intake are
- `gemini` — PASS (11381ms): Discoveries 및 대화 내용에서 견과류(호두, 캐슈넛)와 새우를 알레르기로 명시하고 있으며, 씨앗류는 괜찮고 채소는 단순 불호라는 점이 명확히 드러나 있습니다.

**Probe 2** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (7995ms): Context explicitly states "아빠가 당뇨여서" (father has diabetes) in user's message, which directly satisfies the criterion.
- `opencode` — **INFRA** (13655ms): opencode reply unparseable (114 chars): 통과: 컨텍스트에 사용자의 발언 "아빠가 당뇨여서 저도 걱정이긴 해요"와 식단 관련 조언(정제 탄수화물 감량)이 포함되어 있어, 피험자가 당뇨 가족력을 명확히 언급할 수 있도록 충분한 정보를 제공합니다.

- `codex` — PASS (9001ms): Context explicitly states 아빠가 당뇨여서 저도 걱정이긴 해요 and the assistant summarizes it as 가족력, so the diet-related family health risk is diabetes family history.
- `gemini` — PASS (22747ms): The context explicitly mentions the user's father has diabetes in the conversation tail, providing the necessary factual basis for the required answer.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (16739ms): Context explicitly states weight (73kg), height (174cm), and BMI (24.1) in the tail section.
- `opencode` — **INFRA** (13416ms): opencode reply unparseable (108 chars): 통과: 꼬리 섹션은 사용자의 정확한 체중과 키(73kg, 174cm)와 어시스턴트의 계산된 BMI 24.1을 명시적으로 보여주어, 세 가지 요구 값 모두에 대한 모호함 없는 정보를 제공합니다.

- `codex` — PASS (10422ms): Context explicitly states 체중 73kg and 키 174cm, and the assistant already calculated BMI 24.1, so all required values are present unambiguously.
- `gemini` — PASS (11160ms): The context explicitly states the user's weight is 73kg, height is 174cm, and the calculated BMI is 24.1.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (77004ms): The context explicitly states the user's allergies (nuts—specifically walnuts and cashews, and shrimp) and clarifies that seeds are not allergens, while vegetable preferences, sleep issues, and caffei
- `opencode` — PASS (13028ms): recap에 견과류(호두, 캐슈넛) 및 새우 알레르기가 명시되어 있고, tail 대화에서 씨앗은 괜찮다고 확인되어 알레르기/비알레르기 구분에 충분한 정보가 제공됩니다.
- `codex` — PASS (6874ms): Context explicitly states the user's allergies are nuts especially walnuts and cashews plus shrimp, and it separately states seeds are okay while vegetable dislike, sleep issues, and coffee intake are
- `gemini` — PASS (12916ms): 리캡에 견과류(특히 호두, 캐슈넛)와 새우가 알레르기 항목으로 명시되어 있고, 테일 부분에서 씨앗류는 알레르기가 아니라는 사실이 확인되므로 모든 항목을 정확히 구분하여 나열할 수 있습니다.

**Probe 2** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6584ms): Context contains user's explicit statement "아빠가 당뇨여서" and assistant's acknowledgment of this family history risk factor.
- `opencode` — PASS (12888ms): 컨텍스트 tail에 사용자가 "아빠가 당뇨여서 저도 걱정이긴 해요"라고 명시하고, 어시스턴트가 "가족력 — 정기 혈당 체크 권장합니다"로 확인하여, 가족력 중 식단 관련 건강 위험 요소로 부친 당뇨가 명확히 제공됨.
- `codex` — PASS (5621ms): Context explicitly states 아빠가 당뇨여서 저도 걱정이긴 해요 and the assistant identifies it as 가족력, so the required answer is unambiguous.
- `gemini` — PASS (10039ms): 사용자의 발언 중 아빠가 당뇨라는 가족력 정보가 tail 부분에 명확히 포함되어 있어 질문에 정확히 답변할 수 있습니다.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11891ms): Context explicitly states weight 73kg, height 174cm, and BMI 24.1 in both recap and tail sections.
- `opencode` — PASS (13873ms): recap에 "BMI 24.1로 정상 상위권", tail에 "체중은 73kg, 키 174cm"와 "BMI 24.1"이 명시되어 세 값 모두 충분히 제공됨.
- `codex` — PASS (7591ms): Context explicitly states 체중 73kg and 키 174cm in the tail, and both recap and tail give BMI 24.1, so an agent can include all three required values.
- `gemini` — PASS (9967ms): 컨텍스트의 tail 부분에 사용자가 직접 언급한 체중 73kg, 키 174cm와 어시스턴트가 계산한 BMI 24.1이 명시되어 있습니다.

### `off`

**Probe 1** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (7745ms): Context explicitly lists allergies (nuts—walnuts/cashews, shrimp) and confirms seeds are non-allergens, with no misclassification of other items.
- `opencode` — PASS (22759ms): Context explicitly identifies allergies as 견과류(호두, 캐슈넛) and 새우, and clearly distinguishes non-allergies — 씨앗 confirmed safe ("씨앗은 괜찮아요"), while coffee/vegetable preference/sleep are framed as lifestyl
- `codex` — PASS (5746ms): Context explicitly states severe nut allergy with walnuts and cashews absolutely excluded plus shrimp allergy, and it separately identifies seeds as okay while other details like vegetable dislike, sl
- `gemini` — PASS (14723ms): 대화 내용에 견과류(호두, 캐슈넛)와 새우가 알레르기 항목임이 명시되어 있고, 씨앗류는 괜찮다는 확인과 채소 호불호 및 카페인 섭취 사실이 구분되어 기록되어 있다.

**Probe 2** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12837ms): Context explicitly states "아빠가 당뇨여서" (father has diabetes), directly satisfying the criterion for mentioning family history of diabetes.
- `opencode` — PASS (7101ms): 컨텍스트에 사용자가 "아빠가 당뇨"라고 진술하고, 어시스턴트가 "가족력 — 정제 탄수화물 줄이는 방향"이라고 응답하여, 식이 관련 건강 위험으로서 아버지의 당뇨병 가족력을 명확히 식별할 수 있습니다.
- `codex` — PASS (7027ms): Context explicitly states 아빠가 당뇨여서 저도 걱정이긴 해요, so the agent can clearly answer that the family-history diet-related risk factor is paternal/family diabetes.
- `gemini` — PASS (13881ms): 사용자가 아빠가 당뇨라고 직접 언급한 내용이 컨텍스트에 포함되어 있어 가족력 정보를 정확히 제공할 수 있습니다.

**Probe 3** [tail-trivial] (after turn 32) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8765ms): The context explicitly states the user's weight (73kg), height (174cm), and BMI (24.1).
- `opencode` — PASS (7799ms): 컨텍스트에는 사용자가 직접 명시한 "체중은 73kg, 키 174cm"와 어시스턴트의 계산된 "BMI 24.1"이 포함되어 있어, 세 가지 수치 모두 제공됩니다.
- `codex` — PASS (7127ms): Context explicitly states 체중 73kg and 키 174cm, and the assistant already computed BMI 24.1, so all required values are available unambiguously.
- `gemini` — PASS (10454ms): The context explicitly mentions weight 73kg, height 174cm, and BMI 24.1 in the dialogue history.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.