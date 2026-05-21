# Mini-bench (R7 / judge ensemble) — F-KR-KU-01-knowledge-update — 2026-05-21

- **Fixture**: F-KR-KU-01-knowledge-update (longmem-knowledge-update)
- **Strategies**: reactive, reactive-vercel, realtime, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=2, contextCap=1200 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 1 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 |
|---|---:|---:|---:|---:|---:|
| `reactive` | 0.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 |
| `reactive-vercel` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 |
| `realtime` | 0.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 |
| `off` | 1.000 (n=1) | 1.000 (n=1) | n/a | no | 4.0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `reactive`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10299ms): The context explicitly states the user has completed hiring at Naver and started working there, with the most recent message mentioning "네이버 출근 시작했어. 적응 중."
- `opencode` — PASS (8698ms): 사용자가 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라고 명시했고 이후 네이버 적응 관련 대화가 이어져 현재 직장이 네이버임이 명확함.
- `codex` — PASS (6713ms): Tail states the user was leaving Kakao, then explicitly says 네이버 입사 완료 and 네이버 출근 시작했어, so the current employer is clearly 네이버.
- `gemini` — PASS (12162ms): The context contains explicit messages from the user stating they finished their last week at Kakao and have since started working at Naver.

**Probe 2** [recap-only] (after turn 28) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (13954ms): Context mentions '카카오' but lacks any information about the user's year level at Kakao.
- `opencode` — FAIL (5233ms): 컨텍스트는 사용자가 카카오에서 네이버로 이직했다는 것을 보여주지만, 사용자의 경력 연차(예: '3년차')에 대한 정보는 포함하지 않아 두 필수 요소 모두를 만족할 수 없습니다.
- `codex` — FAIL (10512ms): 문맥에는 사용자가 이직 전 카카오에 있었다는 점만 있고 처음 고민을 시작했을 때의 연차인 3년차 정보는 전혀 없어 카카오 + 3년차를 확정할 수 없다.
- `gemini` — FAIL (13576ms): 컨텍스트 내에 사용자의 근거지인 '카카오'는 명시되어 있으나, 경력 연차인 '3년차'에 대한 정보가 전혀 포함되어 있지 않습니다.

### `reactive-vercel`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (8025ms): Context explicitly states the user transitioned from 카카오 to 네이버, completed 인수인계 at 카카오, and is now working at 네이버 with recent updates about 네이버 적응.
- `opencode` — PASS (6344ms): 컨텍스트에서 사용자가 "네이버 출근 시작했어"라고 말하며 이후 네이버 적응에 대한 대화가 이어져 현재 직장이 네이버임이 명확히 확립된다.
- `codex` — PASS (7027ms): Tail states the user later joined 네이버 and is currently adapting there after leaving 카카오, so the current employer is unambiguously 네이버.
- `gemini` — PASS (12557ms): 사용자가 1개월 전 네이버에 출근을 시작하여 적응 중이라는 사실이 대화 기록 말미에 명시되어 있습니다.

**Probe 2** [recap-only] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11060ms): Context explicitly states "지금 카카오 다닌지 3년 됐어" (I've been at Kakao for 3 years now) when discussing career stagnation, directly providing both company and year level.
- `opencode` — PASS (8632ms): context에 "지금 카카오 다닌지 3년 됐어"가 명확히 나와 카카오 + 3년차 모두 확인 가능.
- `codex` — PASS (8207ms): 컨텍스트 초반에 사용자가 이직 고민을 시작하며 지금 카카오 다닌지 3년 됐다고 명시해 처음 시점의 회사와 연차가 카카오 3년차로 충분히 특정된다
- `gemini` — PASS (10277ms): 컨텍스트 내의 요약(recap) 부분에서 사용자가 이직 고민을 시작할 당시 카카오 다닌지 3년 됐다는 발언과 어시스턴트의 카카오 3년차 확인 내용이 명시되어 있습니다.

### `realtime`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9700ms): Context explicitly states the user left Kakao, started working at Naver, and is currently adapting to Naver, confirming Naver as the current employer.
- `opencode` — PASS (8017ms): 꼬리에는 사용자가 카카오에서 인수인계를 마치고 네이버에 입사하여(“네이버 출근 시작했어. 적응 중”) 현재 네이버에서 일하고 있다는 내용이 포함되어 있어, 현재 고용주를 네이버로 명확히 식별할 수 있습니다.
- `codex` — PASS (6766ms): 문맥에 카카오에서 인수인계 중인 마지막 주를 거쳐 1개월 후 네이버 입사를 완료하고 현재 적응 중이라고 명시되어 있어 현재 직장은 네이버로 충분히 확정된다.
- `gemini` — PASS (10755ms): 사용자가 1개월 전 네이버 출근을 시작하여 현재 적응 중이라고 명시되어 있으며 카카오는 인수인계를 마친 이전 직장임이 명확하다.

**Probe 2** [recap-only] (after turn 28) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (9172ms): Context mentions Kakao as the company when job change consideration began but never specifies the year level (3년차) at that time.
- `opencode` — FAIL (15442ms): 컨텍스트에서 사용자가 카카오 소속이었음은 알 수 있으나, '3년차' 정보가 전혀 없어 정직한 에이전트는 해당 사실을 제공할 수 없다.
- `codex` — FAIL (8581ms): 컨텍스트에는 처음 이직 고민 당시 회사가 카카오였다는 점은 추론되지만 몇 년차였는지에 대한 정보가 전혀 없어 카카오 + 3년차를 확정할 수 없다
- `gemini` — FAIL (69207ms): The context confirms the previous company was Kakao during the handover period, but it contains no mention of the user's seniority or years of experience.

### `off`

**Probe 1** [tail-trivial] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (20421ms): The context explicitly states the user has transitioned from Kakao to Naver, with the latest update confirming they've started at Naver and are in their first month there.
- `opencode` — PASS (10057ms): 컨텍스트에서 사용자가 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라고 명시하여 현재 직장이 네이버임을 명확히 한다.
- `codex` — PASS (6937ms): 문맥 후반에 사용자가 네이버 합격 후 카카오를 떠나 네이버 입사를 완료했고 현재 네이버에 출근 중이라고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (9925ms): context contains user message [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어 which establishes Naver as the current workplace.

**Probe 2** [recap-only] (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9030ms): Context explicitly states "카카오 다닌지 3년 됐어" when discussing job change concerns.
- `opencode` — PASS (4824ms): 컨텍스트에 사용자가 "지금 카카오 다닌지 3년 됐어"라고 명시하여 처음 이직 고민을 시작했을 때의 회사(카카오)와 연차(3년차) 정보가 모두 포함되어 있다.
- `codex` — PASS (6147ms): 초기 이직 고민 시점에 사용자가 지금 카카오 다닌지 3년 됐다고 직접 말해 회사는 카카오이고 연차는 3년차임을 문맥이 명확히 제공한다.
- `gemini` — PASS (10480ms): The context explicitly states the user has been at Kakao for 3 years when they first expressed their job change concerns.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.