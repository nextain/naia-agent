# Mini-bench (judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-20

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 | 4.0 | 0 | 0.000 | 0.000 |
| `realtime` | 0.000 | 3.0 | 1 | 0.000 | 0.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (8366ms): Context lacks any mention of Tuesday's activities, failing to specify '신제품 발표 회의 (13:00-15:00)' for 4월 14일.
- `opencode` — FAIL (11647ms): 컨텍스트에 화요일(4월 14일)의 활동에 대한 정보가 전혀 포함되어 있지 않습니다. 압축 과정에서 이른바 턴의 세부 사항('신제품 발표 회의 (13:00-15:00)')이 손실되었습니다. 남은 턴에서는 토요일 등산, 일요일 영화, 월요일 헬스, 그리고 식단 논의만 언급됩니다.
- `codex` — FAIL (6726ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동 신제품 발표 회의 (13:00-15:00)가 전혀 없고, 월요일 헬스만 일부 보여 정확한 식별 기준을 충족할 수 없습니다.
- `gemini` — FAIL (11491ms): The provided context does not contain any mention of the new product launch meeting or any activities specifically associated with Tuesday, April 14th.

### `realtime`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — FAIL (15852ms): Context lacks any mention of Tuesday's meeting activity, only records Saturday hiking and Sunday movie.
- `opencode` — **INFRA** (12463ms): opencode reply unparseable (176 chars): 실패: 압축된 컨텍스트는 4월 18일 (토), 19일 (일), 그리고 월요일 헬스 세션에 대한 활동만 보여줍니다 — 지난주 화요일 (4월 14일) 항목인 '신제품 발표 회의 (13:00-15:00)'가 손실되었으며,
- `codex` — FAIL (6706ms): CONTEXT에는 지난주 화요일인 4월 14일의 활동인 신제품 발표 회의 (13:00-15:00)가 전혀 남아 있지 않아 정확한 재진술이 불가능하다
- `gemini` — FAIL (9305ms): The context lacks any mention of Tuesday's activity or the 신제품 발표 회의, providing only details for Monday, Saturday, and Sunday.

### `anthropic-native`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15442ms): The context clearly states that on April 14 (Tuesday), the user had a "신제품 발표 회의 (13:00-15:00)" which satisfies the criterion.
- `opencode` — PASS (5377ms): 컨텍스트에는 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"라는 내용이 명확하게 기록되어 있으며, 이는 지난주 화요일에 해당한다.
- `codex` — PASS (5734ms): Context explicitly states that last Tuesday was 4월 14일 화요일 and the user had a 회사 신제품 발표 회의 from 13:00 to 15:00, which exactly matches the pass criterion.
- `gemini` — PASS (8519ms): The context explicitly records that on April 14th (Tuesday), the user had a "신제품 발표 회의" from 1:00 PM to 3:00 PM (13:00-15:00).

### `off`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (20695ms): The context explicitly states that last Tuesday (4월 14일) the user had a "신제품 발표 회의 (13:00-15:00)" which satisfies the criterion.
- `opencode` — PASS (5389ms): 컨텍스트에 4월 14일 (화) 신제품 발표 회의 13:00-15:00 기록이 명확히 존재함.
- `codex` — PASS (7747ms): 컨텍스트에 지난주 화요일인 4월 14일 활동이 회사 신제품 발표 회의 13:00-15:00로 명시되어 있어 PASS 기준을 정확히 충족한다.
- `gemini` — PASS (9359ms): The context explicitly states that on April 14 (Tuesday), the user had a "회사 신제품 발표 회의" from 1:00 PM to 3:00 PM.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
