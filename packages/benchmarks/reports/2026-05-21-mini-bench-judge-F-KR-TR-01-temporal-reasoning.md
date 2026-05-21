# Mini-bench (R7 / judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-21

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: reactive, reactive-vercel, realtime, off
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
| `reactive` | 0.000 (n=1) | n/a | n/a | no | 4.0 |
| `reactive-vercel` | 1.000 (n=1) | n/a | n/a | no | 3.0 |
| `realtime` | 0.000 (n=1) | n/a | n/a | no | 2.0 |
| `off` | 1.000 (n=1) | n/a | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [recap-only] (after turn 25) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — PASS (58686ms): The context lacks any mention of Tuesday (April 14th) activities, so an honest agent would abstain rather than fabricate the required meeting.
- `opencode` — FAIL (9868ms): 컨텍스트에는 4월 14일(화)에 해당하는 활동 기록이 전혀 없으며, 사용자가 "지난주 화요일에 내가 뭐 했지?"라고 물었을 때 답변을 보류해야 하지만, 판정 기준은 해당 활동이 '신제품 발표 회의 (13:00-15:00)'로 정확히 식별되기를 요구하므로, 해당 사실이 누락되어 에이전트가 답변을 보류하게 되어 기준을 충족하지 못합니다.
- `codex` — FAIL (10426ms): Context never states what happened on last Tuesday (April 14) and does not mention 신제품 발표 회의 or its 13:00-15:00 time, so the required exact answer is unsupported.
- `gemini` — FAIL (16584ms): context lacks information about Tuesday (April 14), making it impossible to identify the required activity of a product launch meeting.

### `reactive-vercel`

**Probe 1** [recap-only] (after turn 25) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (17930ms): The context explicitly states that on April 14 (Tuesday), the user had a company new product presentation meeting from 1 PM to 3 PM.
- `opencode` — **INFRA** (10667ms): opencode reply unparseable (155 chars): 통과: 컨텍스트에는 사용자가 명시적으로 "4월 14일 화요일은 회사 신제품 발표 회의가 오후에 있었어. 1시-3시"라고 말한 내용과 어시스턴트가 확인한 "4월 14일 (화): 신제품 발표 회의 13:00-15:00.
- `codex` — PASS (6140ms): Context explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 13:00 to 15:00, which directly satisfies the criterion.
- `gemini` — PASS (14863ms): Context explicitly records that on Tuesday, April 14, the user had a new product launch meeting from 1:00 PM to 3:00 PM.

### `realtime`

**Probe 1** [recap-only] (after turn 25) — ensemble: ❌ FAIL (2/4 valid)

- `glm` — PASS (8134ms): Context lacks any mention of Tuesday (4/14) activities, forcing abstention rather than fabrication.
- `opencode` — **INFRA** (5871ms): opencode reply unparseable (80 chars): 통과: 컨텍스트에는 화요일(4월 14일)에 대한 활동이 포함되어 있지 않아 (금, 토, 일 기록만 있음), 정직한 에이전트는 포기할 것입니다.

- `codex` — FAIL (10083ms): CONTEXT only shows Friday through Sunday activities and generic recap metadata, with no unambiguous record of Tuesday 4월 14일 or the required 신제품 발표 회의 (13:00-15:00).
- `gemini` — **INFRA** (143922ms): gemini timed out after 90000ms

### `off`

**Probe 1** [recap-only] (after turn 25) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11358ms): The context explicitly states that on April 14 (Tuesday), the user had a new product launch meeting from 13:00-15:00.
- `opencode` — PASS (5203ms): 컨텍스트는 명시적으로 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"을 기록하여, 지난주 화요일의 활동에 대한 명확하고 모호하지 않은 답변을 제공합니다.
- `codex` — PASS (21705ms): 컨텍스트에 4월 14일 화요일 활동이 회사 신제품 발표 회의 13:00-15:00로 명시되어 있어 지난주 화요일 활동을 정확히 식별할 수 있다
- `gemini` — PASS (9685ms): 4월 14일 화요일에 오후 1시에서 3시까지 신제품 발표 회의가 있었다는 사실이 대화 기록에 명시되어 있습니다.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.