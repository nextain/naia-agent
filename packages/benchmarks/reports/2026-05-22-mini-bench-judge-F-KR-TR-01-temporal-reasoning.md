# Mini-bench (R7 / judge ensemble) — F-KR-TR-01-temporal-reasoning — 2026-05-22

- **Fixture**: F-KR-TR-01-temporal-reasoning (longmem-temporal-reasoning)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 2615 | 298/118 |
| `hermes` | n/a | 1.000 (n=1) | n/a | **YES (recap empty)** | 4.0 | 0 | 0/0 |
| `reactive` | n/a | 1.000 (n=1) | n/a | no | 3.0 | 1 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 28981 | 233/379 |
| `off` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 25) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8495ms): The context explicitly states that on April 14th (Tuesday), the user had a new product launch meeting from 13:00-15:00.
- `opencode` — PASS (9586ms): 컨텍스트 꼬리에는 '4월 14일 (화): 신제품 발표 회의 13:00-15:00'라는 항목이 명시적으로 포함되어 있으며, 이는 지난주 화요일의 활동과 정확히 일치합니다.
- `codex` — PASS (5841ms): Context explicitly states that on Tuesday, April 14, the user had a company new product announcement meeting from 13:00 to 15:00, which matches the required identification of last Tuesday's activity.
- `gemini` — PASS (10043ms): The context tail explicitly records that on Tuesday, April 14th, the user had a new product presentation meeting from 1:00 PM to 3:00 PM.

### `hermes`

**Probe 1** [tail-trivial] (after turn 25) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14524ms): Context explicitly states Tuesday (4월 14일) activity as 신제품 발표 회의 13:00-15:00 with no ambiguity or confusion with other days.
- `opencode` — PASS (6718ms): 컨텍스트의 4월 14일 목록은 명시적으로 "신제품 발표 회의 13:00-15:00"라고 명시하고 있으며, 이는 요청된 정확한 활동 세부 정보와 일치합니다.
- `codex` — PASS (4698ms): Context explicitly states that on 4월 14일 화요일 the user had a company new product announcement meeting from 13:00 to 15:00, which matches the required identification of 지난주 화요일 활동.
- `gemini` — PASS (16790ms): 컨텍스트에 4월 14일 화요일의 일정이 '신제품 발표 회의 (13:00-15:00)'로 정확하게 기록되어 있습니다.

### `reactive`

**Probe 1** [tail-trivial] (after turn 25) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (19747ms): The context explicitly states that on April 14 (Tuesday), the user had a "신제품 발표 회의 13:00-15:00" (new product presentation meeting 13:00-15:00).
- `opencode` — **INFRA** (13562ms): opencode reply unparseable (141 chars): 통과: 컨텍스트에는 명시적으로 "4월 14일 화요일은 회사 신제품 발표 회의가 오후에 있었어. 1시-3시"가 기록되어 있으며, 도우미가 이를 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"로 확인하여
- `codex` — PASS (7872ms): Context explicitly states that on Tuesday, April 14, the user had a company new product launch meeting from 1:00 to 3:00 PM, which matches the required identification of 신제품 발표 회의 (13:00-15:00).
- `gemini` — PASS (15355ms): 컨텍스트 내 대화 기록(tail)에 4월 14일 화요일 13시에서 15시 사이에 신제품 발표 회의가 있었다는 사실이 명시적으로 포함되어 있습니다.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 25) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (18994ms): The context explicitly states that on April 14th (Tuesday), the user had a 신제품 발표 회의 from 13:00-15:00.
- `opencode` — PASS (12657ms): 컨텍스트 꼬리부분에 사용자가 "4월 14일 화요일은 회사 신제품 발표 회의가 오후에 있었어. 1시-3시"라고 명시하고 어시스턴트가 "4월 14일 (화): 신제품 발표 회의 13:00-15:00"로 기록하여, 지난주 화요일 활동이 신제품 발표 회의 (13:00-15:00)임이 명확하게 확인됩니다.
- `codex` — PASS (5635ms): Context explicitly states that Tuesday, April 14, was a company new product launch meeting from 13:00 to 15:00, which matches the required identification of the Tuesday activity.
- `gemini` — PASS (14359ms): The context explicitly records that on Tuesday, April 14th, the user had a new product launch meeting from 1:00 PM to 3:00 PM.

### `off`

**Probe 1** [tail-trivial] (after turn 25) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16536ms): The context explicitly states that on Tuesday, April 14th, the user had a new product launch meeting from 13:00-15:00.
- `opencode` — PASS (12418ms): Context explicitly records "4월 14일 (화): 신제품 발표 회의 13:00-15:00" as last Tuesday's activity, satisfying the criterion exactly.
- `codex` — PASS (5396ms): 컨텍스트에 지난주 화요일이 2026-04-14이며 사용자가 오후 1시-3시에 회사 신제품 발표 회의가 있었다고 명시되어 있어 정확히 식별할 수 있다.
- `gemini` — PASS (11544ms): 컨텍스트에 4월 14일 화요일 활동으로 신제품 발표 회의(13:00-15:00)가 명시되어 있어 정확한 답변이 가능함.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.