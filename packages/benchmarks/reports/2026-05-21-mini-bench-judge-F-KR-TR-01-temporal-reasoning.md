# Mini-bench (judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-21

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (14947ms): Context lacks any information about what the user did on Tuesday, April 14, 2026.
- `opencode` — FAIL (19146ms): 컨텍스트에는 목요일~일요일 활동에 대한 세부 정보만 포함되어 있으며, 화요일(4월 14일) 활동인 "신제품 발표 회의(13:00-15:00)"는 압축 과정에서 손실되어 어떤 턴에서도 찾을 수 없습니다.
- `codex` — FAIL (6948ms): 컨텍스트에는 지난주 화요일인 2026-04-14의 활동 정보가 없고 월요일 헬스와 토요일 등산만 보여 정확한 신제품 발표 회의 (13:00-15:00)를 식별할 수 없습니다.
- `gemini` — FAIL (13106ms): The context lacks any mention of Tuesday's activity (April 14th) or the product launch meeting specified in the pass criterion.

### `reactive-vercel`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12164ms): The context accurately identifies that on April 14th (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (10141ms): 컨텍스트는 화요일(4월 14일)의 활동을 "신제품 발표 회의 13:00-15:00"으로 명시적으로 기록하여, 다른 요일과의 혼동 없이 기준을 충족합니다.
- `codex` — PASS (9875ms): 컨텍스트에 지난주 화요일인 2026-04-14의 활동이 회사 신제품 발표 회의였고 시간이 13:00-15:00라고 명시되어 있어 기준을 충족한다.
- `gemini` — PASS (10909ms): The context explicitly records April 14th (Tuesday) as having a company new product launch meeting from 13:00 to 15:00.

### `realtime`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (16076ms): Context lacks information about the user's activity on Tuesday, April 14th.
- `opencode` — FAIL (17619ms): 컨텍스트에는 지난주 화요일(4월 14일) 활동에 대한 기록이 전혀 없으며, 요구되는 '신제품 발표 회의 (13:00-15:00)'라는 정보가 누락되어 있어 월요일(헬스)과 토/일요일 활동만 확인 가능합니다.
- `codex` — FAIL (10451ms): CONTEXT에는 지난주 화요일인 4월 14일의 활동 신제품 발표 회의 (13:00-15:00)가 전혀 남아 있지 않아 정확 식별이 불가능하다
- `gemini` — FAIL (11485ms): The context contains information about Monday (Gym), Saturday (Hiking), and Sunday (Movies), but completely lacks any mention of the 'New Product Launch Meeting' required for Tuesday (April 14).

### `anthropic-native`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (19750ms): The context accurately states that on April 14 (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (6166ms): 컨텍스트에는 사용자가 "4월 14일 화요일에 오후 1시-3시 회사 신제품 발표 회의"를 진행했다고 명시되어 있으며, 이에 따라 어시스턴트가 "4월 14일 (화): 신제품 발표 회의 13:00-15:00. 기록."라고 기록했습니다.
- `codex` — PASS (8574ms): CONTEXT explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which exactly satisfies the criterion.
- `gemini` — PASS (11877ms): The context explicitly states that on April 14th (Tuesday), the user had a new product launch meeting from 1:00 PM to 3:00 PM.

### `off`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15769ms): The context accurately states that on April 14 (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (5797ms): 컨텍스트는 4월 14일(화)를 "신제품 발표 회의 13:00-15:00"으로 명시합니다.
- `codex` — PASS (13726ms): Context explicitly states that last Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which matches the required identification.
- `gemini` — PASS (10029ms): 컨텍스트 내의 4월 14일 화요일 대화 내용에 '회사 신제품 발표 회의(1시-3시)'가 명확히 기록되어 있습니다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
