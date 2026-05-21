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
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (13253ms): Context lacks any mention of Tuesday's activity; only Friday, Saturday, and Sunday activities are recorded.
- `opencode` — FAIL (17894ms): 지난주 화요일(4월 14일) '신제품 발표 회의 (13:00-15:00)' 내용이 compaction recap에서 유실되었고, 잔여 context에는 금/토/일/월 활동만 남아 해당 정보가 없습니다.
- `codex` — FAIL (7510ms): 컨텍스트에는 지난주 화요일인 2026-04-14의 활동 내용이 없고 금·토·일 일부 기록만 있어 신제품 발표 회의 (13:00-15:00)를 정확히 식별할 수 없습니다.
- `gemini` — FAIL (13428ms): The context contains information for Monday, Friday, Saturday, and Sunday, but completely lacks the specific fact about the product launch meeting (신제품 발표 회의) on Tuesday (April 14).

### `reactive-vercel`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11619ms): The context clearly states that on April 14 (Tuesday), the user had a new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (4666ms): 4월 14일 (화) 신제품 발표 회의 13:00-15:00 가 컨텍스트에 명시되어 있습니다.
- `codex` — PASS (7302ms): Context explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which matches the required identification of 신제품 발표 회의 (13:00-15:00).
- `gemini` — PASS (11591ms): 컨텍스트에 4월 14일 화요일 활동이 신제품 발표 회의(13:00-15:00)로 명확하게 기록되어 있습니다.

### `realtime`

**Probe 1** (after turn 26) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (11772ms): Context lacks any mention of Tuesday's activity, only covering Monday, Saturday, and Sunday.
- `opencode` — FAIL (13154ms): 컨텍스트에는 목(4/17), 금(4/18), 토(4/19), 월(헬스) 활동만 보이며, 화요일(4/14) '신제품 발표 회의 (13:00-15:00)'에 대한 정보가 전혀 포함되어 있지 않습니다.
- `codex` — FAIL (7167ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동 정보가 없고 월요일 헬스만 간접 언급될 뿐이라 신제품 발표 회의 (13:00-15:00)를 정확히 복원할 근거가 없습니다.
- `gemini` — FAIL (11238ms): The context contains records for Monday, Friday, Saturday, and Sunday, but omits any mention of Tuesday (April 14) or the '신제품 발표 회의'.

### `anthropic-native`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13360ms): The context clearly states that on April 14 (Tuesday), the user had a company new product presentation meeting from 13:00-15:00.
- `opencode` — PASS (10389ms): 컨텍스트에 "4월 14일 화요일은 회사 신제품 발표 회의가 오후에 있었어. 1시-3시"와 "4월 14일 (화): 신제품 발표 회의 13:00-15:00. 기록."이 모두 포함되어 있어, 지난주 화요일 활동이 신제품 발표 회의(13:00-15:00)임을 정확히 식별할 수 있다.
- `codex` — PASS (6077ms): Context explicitly states that last Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which satisfies the criterion.
- `gemini` — PASS (9501ms): 컨텍스트 내에 4월 14일 화요일 활동으로 신제품 발표 회의(13:00-15:00)가 명확히 기록되어 있습니다.

### `off`

**Probe 1** (after turn 26) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (34405ms): The context explicitly states that on April 14 (Tuesday), the user had a new product presentation meeting from 1 PM to 3 PM.
- `opencode` — **INFRA** (15723ms): opencode reply unparseable (108 chars): 통과: 컨텍스트는 명시적으로 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"를 기록하여, 지난주 화요일 활동을 신제품 발표 회의 (13:00-15:00)로 정확하게 식별합니다.

- `codex` — PASS (7233ms): Context explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which matches the required identification.
- `gemini` — PASS (10952ms): 2026년 4월 20일 기준 지난주 화요일인 4월 14일에 회사 신제품 발표 회의(13:00-15:00)가 있었다는 사실이 대화 기록에 명시되어 있습니다.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
