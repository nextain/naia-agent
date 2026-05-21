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
| `realtime` | 0.000 | 3.0 | 1 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (15412ms): Context lacks information about what the user did on Tuesday, April 14, 2026.
- `opencode` — FAIL (9330ms): 지난주 화요일(4월 14일) 활동에 대한 기록이 컴텍스트에 존재하지 않습니다. 압축 과정에서 손실되었으며, 월요일(헬스), 토요일(등산), 일요일(영화)만 보입니다.
- `codex` — FAIL (7619ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동 내용이 전혀 남아 있지 않아 신제품 발표 회의 (13:00-15:00)라고 정확히 식별할 근거가 없다.
- `gemini` — FAIL (11721ms): The context contains information about Monday, Saturday, and Sunday of last week, but lacks any mention of Tuesday (April 14) or the specific activity '신제품 발표 회의 (13:00-15:00)'.

### `reactive-vercel`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (18120ms): The context accurately identifies last Tuesday's activity as "신제품 발표 회의 (13:00-15:00)" without confusing it with other days' activities.
- `opencode` — PASS (7591ms): 컨텍스트에 명확하게 4월 14일 (화요일)을 "신제품 발표 회의 13:00-15:00"으로 기록한 것이 포함되어 있어, 기준을 충족합니다.
- `codex` — PASS (7244ms): Context explicitly states that last Tuesday, April 14, was a company new product launch meeting from 13:00 to 15:00, which matches the required identification of 신제품 발표 회의 (13:00-15:00).
- `gemini` — PASS (10871ms): The context explicitly records that on Tuesday, April 14th, the user had a '신제품 발표 회의' from 13:00 to 15:00.

### `realtime`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (8975ms): Context lacks any mention of last Tuesday's activities, only showing Monday (헬스) and Sunday (영화) activities.
- `opencode` — **INFRA** (22362ms): opencode reply unparseable (145 chars): 실패: 컨텍스트에서는 월요일(헬스), 토요일(북한산 등산), 일요일(영화) 활동만 보여주지만, 지난주 화요일(4월 14일) 활동에 대한 구체적인 내용, 특히 '신제품 발표 회의 (13:00-15:00)'는 요약이나 
- `codex` — FAIL (8566ms): 컨텍스트에는 지난주 화요일인 2026-04-14의 활동 정보가 전혀 없고 신제품 발표 회의 (13:00-15:00)라는 핵심 사실도 없어 정확 식별이 불가능합니다.
- `gemini` — FAIL (11578ms): The context mentions activities for Monday, Saturday, and Sunday, but completely lacks any information about the 'New product launch meeting' or any specific activity for Tuesday, April 14th.

### `anthropic-native`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (13775ms): The context explicitly states that on April 14 (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — **INFRA** (8874ms): opencode reply unparseable (132 chars): 통과: 컨텍스트는 명시적으로 "4월 14일 화요일은 회사 신제품 발표 회의가 오후에 있었어. 1시-3시"라고 명시하고 확인을 위해 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"를 기록하여, 기준을 
- `codex` — PASS (6990ms): Context explicitly states that last Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which matches the required identification of 신제품 발표 회의 (13:00-15:00).
- `gemini` — PASS (11136ms): 컨텍스트 내의 대화 기록에 4월 14일 화요일 13:00-15:00에 신제품 발표 회의가 있었다는 사실이 명시적으로 포함되어 있습니다.

### `off`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (39014ms): The context clearly states that on April 14 (Tuesday), the user had a company new product presentation meeting from 1 PM to 3 PM.
- `opencode` — PASS (10862ms): CONTEXT에 4월 14일 화요일 활동이 '신제품 발표 회의 13:00-15:00'로 명시되어 있어 (사용자 입력 + 어시스턴트 기록 모두 포함), PASS CRITERION을 충족한다.
- `codex` — PASS (13321ms): Context explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, satisfying the required identification of 신제품 발표 회의 (13:00-15:00).
- `gemini` — PASS (18656ms): The context explicitly records that on Tuesday, April 14th, the user had a company new product presentation meeting from 13:00 to 15:00.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
