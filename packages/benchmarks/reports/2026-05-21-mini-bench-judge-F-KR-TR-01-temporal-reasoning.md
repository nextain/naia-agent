# Mini-bench (judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-21

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 3.0 | 1 | 0.000 | 0.000 |
| `reactive-vercel` | 0.000 | 3.0 | 1 | 0.000 | 1.000 |
| `realtime` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (13345ms): Context lacks any mention of Tuesday activities or the specific meeting required by the criterion.
- `opencode` — **INFRA** (11874ms): opencode reply unparseable (129 chars): 실패: 컨텍스트에 화요일(4월 14일) 활동이 전혀 포함되어 있지 않습니다 — 압축으로 인해 "신제품 발표 회의 (13:00-15:00)" 세부 정보가 손실되어, 기준을 충족하기 위해 필요한 정보를 에이전트가 사용할
- `codex` — FAIL (11391ms): CONTEXT에는 지난주 화요일인 4월 14일의 활동 정보가 전혀 없어서 신제품 발표 회의 (13:00-15:00)를 정확히 식별할 근거가 없다
- `gemini` — FAIL (12317ms): The activity 'New Product Launch Meeting (13:00-15:00)' for Tuesday, April 14th, is completely missing from the provided context.

### `reactive-vercel`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (16076ms): Context lacks any mention of Tuesday's activities or the 신제품 발표 회의 (13:00-15:00) event.
- `opencode` — **INFRA** (12744ms): opencode reply unparseable (111 chars): 실패: 이 컨텍스트는 월요일 헬스, 토요일 등산, 일요일 영화만 언급하며 — 화요일(4월 14일) 활동이나 '신제품 발표 회의 (13:00-15:00)'에 대한 정보는 압축 과정에서 손실되었습니다.

- `codex` — FAIL (10447ms): CONTEXT에는 지난주 화요일인 4월 14일의 활동 신제품 발표 회의 (13:00-15:00) 정보가 없고, 월요일 헬스 언급만 있어 정확 식별 기준을 충족할 수 없다.
- `gemini` — FAIL (9235ms): The provided context contains no information regarding Tuesday, April 14th, or the '신제품 발표 회의 (13:00-15:00)'.

### `realtime`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (9919ms): Context lacks any mention of last Tuesday's activities or the specific meeting.
- `opencode` — FAIL (5200ms): 압축된 컨텍스트에는 지난주 화요일 활동(4월 14일 신제품 발표 회의)에 대한 정보가 전혀 포함되어 있지 않으며, 총 7개 활동에 대한 요약만 표시됩니다.
- `codex` — FAIL (7793ms): Context only includes 4월 18일 토요일 북한산 등산, 4월 19일 일요일 영화, and a summary that 월요일 was 헬스, but it never states 지난주 화요일 4월 14일의 활동이나 신제품 발표 회의 13:00-15:00 정보가 없다.
- `gemini` — FAIL (12295ms): The context contains information for Monday, Saturday, and Sunday, but completely lacks any mention of Tuesday's activity or the new product presentation meeting.

### `anthropic-native`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (30898ms): The context clearly states that on April 14 (Tuesday), the user had a "신제품 발표 회의 (13:00-15:00)" which satisfies the criterion.
- `opencode` — PASS (7422ms): Context에 "4월 14일 (화): 신제품 발표 회의 13:00-15:00" 이 명확히 기록되어 있어 화요일 활동을 정확히 식별 가능함.
- `codex` — PASS (7013ms): Context explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 1:00 PM to 3:00 PM, which matches the required identification of 신제품 발표 회의 (13:00-15:00).
- `gemini` — PASS (10678ms): The context explicitly records that on April 14 (Tuesday), the user had a product launch meeting from 1:00 PM to 3:00 PM.

### `off`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (20583ms): The context clearly states that last Tuesday (4월 14일) the user had a "신제품 발표 회의 (13:00-15:00)" which satisfies the criterion.
- `opencode` — PASS (6353ms): 컨텍스트에는 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"가 명확하게 기록되어 있으며, 이는 지난주 화요일의 활동으로 정확하게 식별할 수 있습니다.
- `codex` — PASS (6777ms): Context explicitly states that last Tuesday was 4월 14일 화요일 and the activity was 회사 신제품 발표 회의 from 13:00 to 15:00, which satisfies the required identification.
- `gemini` — PASS (10260ms): Context explicitly records "4월 14일 (화): 신제품 발표 회의 13:00-15:00" in the conversation history.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
