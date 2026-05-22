# Mini-bench (R7 / judge ensemble) — F-KR-KU-01-knowledge-update — 2026-05-22

- **Fixture**: F-KR-KU-01-knowledge-update (longmem-knowledge-update)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | 0.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 | 2175 | 302/107 |
| `hermes` | 0.000 (n=1) | 1.000 (n=1) | n/a | **YES (recap empty)** | 3.5 | 0 | 0/0 |
| `reactive` | 0.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 | 1 | 0/0 |
| `naia+llm` | 0.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 | 16107 | 248/602 |
| `off` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 3.5 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10544ms): The context clearly shows the user has completed their Kakao job and is now working at Naver, with recent messages indicating they've started at Naver and are adapting to it.
- `opencode` — PASS (15024ms): 컨텍스트에 사용자가 카카오에서 인수인계를 마치고 네이버에 입사하여 "네이버 출근 시작했어. 적응 중."이라고 명시했으므로 현재 직장은 네이버입니다.
- `codex` — PASS (10550ms): Tail context explicitly states the user finished at 카카오 and then after joining says 네이버 출근 시작했어, so the current employer is unambiguously 네이버.
- `gemini` — PASS (11074ms): The context explicitly states '네이버 출근 시작했어. 적응 중.' and records a follow-up conversation about the user's current adjustment to the team at Naver.

**Probe 2** [recap-only] (after turn 28) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (6433ms): Context mentions '카카오' but never specifies the user's year level at Kakao.
- `opencode` — FAIL (11075ms): 컨텍스트는 사용자가 카카오에서 근무했음을 나타내지만(퇴사 전 마지막 주), 연차나 입사 연도에 대한 정보가 포함되어 있지 않아 이직을 처음 고민하기 시작했을 때 몇 년차인지 알 수 없습니다.
- `codex` — FAIL (8621ms): 컨텍스트에는 사용자가 이전 회사가 카카오였다는 정보만 있고 처음 이직 고민을 시작했을 때의 연차 3년차 정보는 전혀 없어 기준 응답을 뒷받침할 수 없다
- `gemini` — FAIL (23907ms): The context mentions the user was at Kakao but lacks any information regarding their years of experience or being in their 3rd year.

### `hermes`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (19837ms): Context explicitly states user started at Naver and is currently adapting there, with Kakao mentioned as past employment.
- `opencode` — PASS (12801ms): 컨텍스트에 "[1개월 후 — 네이버 입사 완료]" 이후 사용자가 네이버 출근을 시작했고 적응 중이라고 명시되어 있어 현재 직장이 네이버임이 명확하다.
- `codex` — PASS (5527ms): 문맥에 사용자가 카카오를 떠나 네이버에 합격했고 이어 네이버 입사 완료 후 출근 중이라고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (11264ms): 사용자가 카카오에서의 인수인계를 마치고 네이버에 입사하여 출근을 시작하고 적응 중이라는 사실이 대화 내용에 명시되어 있다.

**Probe 2** [recap-only] (after turn 28) — ensemble: ❌ FAIL (3/4 valid)

- `glm` — PASS (12083ms): Context mentions Kakao multiple times but never specifies the user's year level at Kakao.
- `opencode` — **INFRA** (13372ms): opencode reply unparseable (86 chars): 실패: 카카오는 컨텍스트에 명시되어 있지만(마지막 주), 연차(3년)에 대한 정보는 전혀 포함되어 있지 않아 에이전트가 해당 정보를 제공할 수 없습니다.

- `codex` — FAIL (7705ms): 문맥에는 당시 회사가 카카오였다는 단서는 있지만 이직 고민을 처음 시작했을 때의 연차인 3년차 정보가 전혀 없어 기준 답을 완성할 수 없다.
- `gemini` — FAIL (14572ms): The context identifies the previous company as Kakao but contains no mention of the user's specific years of experience (3년차).

### `reactive`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (11469ms): The context clearly shows the user has completed the handover at Kakao and started working at Naver, with the most recent message confirming they are currently adapting to their new job at Naver.
- `opencode` — **INFRA** (17473ms): opencode reply unparseable (112 chars): 통과: 컨텍스트 꼬리에서 사용자가 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라고 명시하고 카카오에서의 인수인계가 완료되었음을 확인하여, 현재 직장을 네이버로 명확히 파악할 수 있다.

- `codex` — PASS (6363ms): Tail context explicitly says 카카오 was the previous job during handoff and then confirms 현재 상태로 네이버 입사 완료 후 출근 시작했어, so the user's current company is 네이버.
- `gemini` — PASS (15246ms): The context explicitly states that the user has started working at Naver after finishing their tenure at Kakao, identifying Naver as the current workplace.

**Probe 2** [recap-only] (after turn 28) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (30516ms): Context mentions '카카오' but lacks any information about years of service at Kakao.
- `opencode` — FAIL (16461ms): 컨텍스트는 사용자가 카카오 출신이라는 것을 보여주지만(“카카오 마지막 주야”), 연차(‘3년차’)에 대한 정보는 어디에도 언급되지 않아, 에이전트가 두 가지 모두를 포함하는 답변을 생성할 수 없습니다.
- `codex` — FAIL (9029ms): 컨텍스트에는 이직 직전 회사가 카카오라는 정보만 있고 처음 고민을 시작했을 때의 연차 3년차는 전혀 제공되지 않아 기준 답을 확정할 수 없다.
- `gemini` — FAIL (15750ms): context mentions the user was at Kakao but provides no information about their years of experience or the 3-year tenure required by the criterion.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (12771ms): The context clearly states the user has transitioned from Kakao to Naver and is currently working at Naver, with recent messages mentioning "네이버 출근 시작했어" (I've started working at Naver) and discussing
- `opencode` — **INFRA** (21120ms): opencode reply unparseable (128 chars): 통과: 꼬리 부분은 사용자가 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라고 명시하고 "팀 분위기 좋아. 카카오랑은 또 다른 매력"이라고 덧붙여, 현재 고용주가 네이버(카카오는 이전 직장)임을 명확히
- `codex` — PASS (5619ms): Tail states the user was in their last week at 카카오, then later says 네이버 입사 완료 and 네이버 출근 시작했어, so the current employer is unambiguously 네이버.
- `gemini` — PASS (11127ms): 네이버 입사 완료 및 출근 시작 사실과 팀 분위기에 만족하며 적응 중이라는 정보가 컨텍스트에 명시되어 있어 현재 직장을 네이버로 판단할 수 있습니다.

**Probe 2** [recap-only] (after turn 28) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (8734ms): Context mentions '카카오' during handover but never specifies the user's year level (e.g., '3년차') at Kakao.
- `opencode` — FAIL (23182ms): 컨텍스트에 카카오는 확인되나 '3년차' 정보가 전혀 없어, 해당 기준을 충족하는 답변이 불가능합니다.
- `codex` — FAIL (6308ms): 컨텍스트에는 당시 회사가 카카오였다는 정보만 있고 몇 년차였는지는 전혀 없어 카카오 + 3년차를 모두 포함한 답을 뒷받침할 수 없다
- `gemini` — FAIL (16842ms): The context identifies the previous company as Kakao but does not provide the specific number of years of experience required by the pass criterion.

### `off`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (10246ms): The context explicitly states the user has started working at Naver and is adapting there, confirming it as their current employer.
- `opencode` — **INFRA** (10057ms): opencode reply unparseable (136 chars): 통과: 문맥은 사용자가 처음에 카카오에서 일했지만, 네이버 합격 소식, 카카오에서의 마지막 주 인수인계 확인, 그리고 "[1개월 후 — 네이버 입사 완료]" 항목을 통해 네이버 출근을 시작했음을 명확히 보여주므로, 
- `codex` — PASS (5032ms): Context explicitly states that after finishing at Kakao the user started work at Naver with the latest update saying 네이버 출근 시작했어, so the current employer is clearly 네이버.
- `gemini` — PASS (12232ms): 사용자가 네이버 출근을 시작하고 적응 중이며 팀 분위기가 좋다고 언급한 대화 내용이 포함되어 있어 현재 직장이 네이버임을 명확히 알 수 있다.

**Probe 2** [recap-only] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9862ms): Context explicitly states "카카오 다닌지 3년 됐어" when discussing job change concerns.
- `opencode` — PASS (14228ms): 사용자가 "지금 카카오 다닌지 3년 됐어"라고 명시하여 이직 고민 시작 시 카카오 3년차임이 모두 제공됨.
- `codex` — PASS (13278ms): 처음 이직 고민 시점에 사용자가 지금 카카오 다닌지 3년 됐어라고 명시해 회사가 카카오이고 연차가 3년차임을 충분히 알 수 있다
- `gemini` — PASS (11135ms): 사용자가 처음 이직 고민을 말했을 때 카카오 다닌지 3년 됐다고 직접 언급하였으며 어시스턴트가 카카오 3년차라고 재확인하는 내용이 포함되어 있다.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.