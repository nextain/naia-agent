# Mini-bench (R7 / judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-21

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: pi, hermes, reactive, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 0 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `pi` | 0.000 (n=1) | n/a | n/a | no | 3.0 |
| `hermes` | 0.000 (n=1) | n/a | n/a | **YES (recap empty)** | 4.0 |
| `reactive` | 0.000 (n=1) | n/a | n/a | no | 3.0 |
| `off` | 1.000 (n=1) | n/a | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [recap-only] (after turn 25) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (51319ms): Context lacks any mention of Tuesday's activities, so an honest agent would abstain rather than fabricate the required meeting.
- `opencode` — **INFRA** (7135ms): opencode reply unparseable (77 chars): 실패: 4월 14일 화요일 활동은 리캡 요약이나 대화 내용 어디에도 명시되어 있지 않아, 에이전트가 정직하게 응답을 거부할 수 있습니다.

- `codex` — FAIL (7022ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동 정보가 전혀 없고 금-일 기록과 월요일 헬스만 있어 신제품 발표 회의 (13:00-15:00)를 정확히 식별할 수 없다.
- `gemini` — FAIL (26981ms): context lacks any information about April 14th or the new product launch meeting, making it impossible to satisfy the identification criterion.

### `hermes`

**Probe 1** [recap-only] (after turn 25) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (11776ms): Context lacks any mention of Tuesday's activities, so an honest agent would abstain rather than fabricate the required meeting.
- `opencode` — FAIL (14390ms): CONTEXT에 화요일(4월 14일) 활동 기록이 전혀 없어 '신제품 발표 회의 (13:00-15:00)'라는 정답을 도출할 정보가 부재하며, 월(헬스), 금(부모님), 토(등산), 일(영화)만 나열되어 있어 화요일 활동은 누락됨.
- `codex` — FAIL (7323ms): Context never states what happened on last Tuesday/4월 14일 and only mentions other days like Monday gym and 4월 17-19 activities, so the required meeting cannot be identified.
- `gemini` — FAIL (19211ms): 컨텍스트에 4월 14일 화요일의 활동인 신제품 발표 회의에 대한 정보가 전혀 포함되어 있지 않아 해당 활동을 식별할 수 없습니다.

### `reactive`

**Probe 1** [recap-only] (after turn 25) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (9323ms): Context lacks any mention of Tuesday (4월 14일) activities, forcing abstention.
- `opencode` — FAIL (19111ms): 컨텍스트에는 지난주 화요일(4월 14일)의 활동에 대한 정보가 전혀 포함되어 있지 않으며, 리캡은 7개 활동이 정리되었다고만 언급하고 개별 화요일 내용은 요약에서 누락되어 '신제품 발표 회의 (13:00-15:00)'를 식별할 수 없습니다.
- `codex` — FAIL (8706ms): 컨텍스트에는 지난주 화요일인 4월 14일의 활동이 명시되어 있지 않아 신제품 발표 회의 (13:00-15:00)를 정확히 식별할 근거가 없다.
- `gemini` — **INFRA** (135038ms): gemini timed out after 90000ms

### `off`

**Probe 1** [recap-only] (after turn 25) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14373ms): The context explicitly states that on April 14th (Tuesday), the user had a new product launch meeting from 13:00-15:00.
- `opencode` — PASS (6398ms): Context는 4월 14일 (화) 활동이 '신제품 발표 회의 13:00-15:00'라고 명시하고 있으며, 이는 지난주 화요일에 해당합니다.
- `codex` — PASS (7168ms): 컨텍스트에 지난주 화요일이 4월 14일이며 사용자가 오후 1시-3시에 회사 신제품 발표 회의가 있었다고 명시돼 있어 정확히 신제품 발표 회의 13:00-15:00로 답할 수 있다
- `gemini` — PASS (9955ms): 대화 내용에 4월 14일 화요일 활동으로 신제품 발표 회의(13:00-15:00)가 명시되어 있어 정확한 답변이 가능함.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.