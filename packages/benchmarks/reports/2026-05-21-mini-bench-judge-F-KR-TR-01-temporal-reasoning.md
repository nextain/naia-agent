# Mini-bench (judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-21

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 3.0 | 1 | 0.000 | 0.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 0.000 | 3.0 | 1 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (61053ms): The context does not contain any information about the user's activity on Tuesday (April 14, 2026), only mentioning activities from Friday, Saturday, and Sunday of the previous week.
- `opencode` — **INFRA** (19000ms): opencode reply unparseable (120 chars): 실패: 압축된 recap은 목요일~일요일 활동과 월요일 헬스만 보존하지만, 화요일(4월 14일)의 '신제품 발표 회의 (13:00-15:00)'는 손실되어 요청된 사실을 CONTEXT에서 전혀 확인할 수 없습니다.

- `codex` — FAIL (10131ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동 정보가 없고 신제품 발표 회의 (13:00-15:00)라는 핵심 사실이 재현되지 않아 정확한 식별 기준을 만족할 수 없습니다.
- `gemini` — FAIL (39185ms): The context mentions Monday's activity (gym) but lacks any information regarding the 'new product presentation meeting' on Tuesday (April 14th) required by the pass criterion.

### `reactive-vercel`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (37556ms): The context accurately states that on April 14th (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (10920ms): 컨텍스트에 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"가 명시적으로 기록되어 있어, 지난주 화요일 활동이 신제품 발표 회의(13:00-15:00)로 정확히 식별 가능하다.
- `codex` — PASS (9330ms): 컨텍스트에 4월 14일 화요일 활동이 회사 신제품 발표 회의 오후 1시-3시로 명시되어 있어 지난주 화요일을 정확히 신제품 발표 회의 (13:00-15:00)로 식별할 수 있다
- `gemini` — PASS (14135ms): 컨텍스트 내 4월 14일 화요일 대화 내용에 신제품 발표 회의(13:00-15:00)가 명확하게 기록되어 있습니다.

### `realtime`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (22991ms): Context lacks any mention of Tuesday (4월 14일) activities, only covering Fri-Sun and Monday.
- `opencode` — **INFRA** (14703ms): opencode reply unparseable (144 chars): 실패: 컨텍스트에 금요일(17일), 토요일(18일), 일요일(19일), 월요일(헬스)에 대한 활동은 포함되어 있지만, 화요일(4월 14일)에 대한 활동은 전혀 언급되지 않았습니다. 요구되는 "신제품 발표 회의(13:
- `codex` — FAIL (18440ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동 신제품 발표 회의 (13:00-15:00)가 전혀 없고 금·토·일 및 월요일 헬스만 언급되어 있어 정확히 식별할 수 없습니다
- `gemini` — FAIL (12584ms): The context does not mention the activity for last Tuesday (April 14), missing the specific '신제품 발표 회의' information required by the pass criterion.

### `anthropic-native`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (32426ms): The context accurately records that on April 14 (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — **INFRA** (10534ms): opencode reply unparseable (111 chars): 통과: 컨텍스트에 명시적으로 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"가 기록되어 있으며, 이는 사용자 입력 "회사 신제품 발표 회의가 오후에 있었어. 1시-3시"와 일치한다.

- `codex` — PASS (12628ms): Context explicitly states that last Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which matches the required identification exactly.
- `gemini` — PASS (13120ms): The context explicitly records that on Tuesday, April 14, the user attended a company new product launch meeting from 1:00 PM to 3:00 PM.

### `off`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (40792ms): The context clearly states that on April 14 (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (11491ms): 컨텍스트에 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"라는 항목이 명시적으로 기록되어 있어, 지난주 화요일의 활동을 정확하게 식별할 수 있습니다.
- `codex` — PASS (8062ms): 문맥에 4월 14일 화요일 활동이 회사 신제품 발표 회의였고 시간도 13:00-15:00라고 명시되어 있어 기준을 정확히 충족한다
- `gemini` — PASS (10715ms): Context explicitly records that on Tuesday, April 14, the user had a new product launch meeting from 13:00 to 15:00.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
