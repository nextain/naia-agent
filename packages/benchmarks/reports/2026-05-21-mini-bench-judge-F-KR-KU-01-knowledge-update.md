# Mini-bench (judge ensemble) — F-KR-KU-01-knowledge-update — 2026-05-21

- **Fixture**: F-KR-KU-01-knowledge-update (longmem-knowledge-update)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |
| `reactive-vercel` | 0.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (14736ms): The context clearly shows the user has transitioned from Kakao to Naver and is currently working at Naver, as confirmed in the most recent messages.
- `opencode` — **INFRA** (7573ms): opencode reply unparseable (131 chars): 통과: 컨텍스트는 사용자가 "[3개월 후] 네이버 합격"에서 카카오에서 네이버로 이직했음을 명시하고, 이후 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어" 및 "팀 분위기 좋아"는 현재 네이버에서 근무 
- `codex` — PASS (7483ms): CONTEXT states the user said 네이버 합격 후 다음달 출근, then later explicitly said 네이버 출근 시작했어 적응 중, which establishes the current workplace as 네이버.
- `gemini` — PASS (11150ms): The context explicitly states the user has started working at Naver and is currently adapting to the new environment after leaving Kakao.

### `reactive-vercel`

**Probe 1** (after turn 28) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (12589ms): CONTEXT shows user currently employed at 카카오 (3 years) while interviewing at 네이버/토스, with no indication of resignation or job change.
- `opencode` — FAIL (8299ms): CONTEXT는 사용자가 현재 카카오에 다니고 있으며 네이버와 토스에 면접 중임을 명확히 보여주지만, 네이버에 합류했다는 정보는 포함되어 있지 않아 "네이버"를 현재 직장으로 식별할 수 있는 근거가 없습니다.
- `codex` — FAIL (10142ms): CONTEXT only states the user currently works at 카카오 and is interviewing with 네이버 and 토스, so it lacks any faithful evidence that the current employer is 네이버.
- `gemini` — FAIL (41480ms): The context is truncated at turn 16 and lacks any information about the user joining Naver, showing them only as a Kakao employee interviewing at other companies.

### `realtime`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (36933ms): The context clearly shows the user transitioned from Kakao to Naver, with the most recent updates confirming they've started working at Naver and are adapting to their new role.
- `opencode` — PASS (14881ms): 컨텍스트에 사용자가 카카오에서 인수인계를 마치고 네이버에 입사하여 현재 출근 중이라는 이력("네이버 출근 시작했어", "팀 분위기 좋아")이 명확히 기록되어 현재 직장 = 네이버임을 충분히 확인할 수 있음.
- `codex` — PASS (6379ms): Context explicitly says the user was in their last week at 카카오, then later started work at 네이버 and is currently adapting there, so the current company is 네이버.
- `gemini` — PASS (10740ms): The context explicitly states the user has joined Naver and is currently adapting to the team after leaving Kakao.

### `anthropic-native`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14130ms): Context explicitly states the user started at Naver and is no longer at Kakao, confirming current employment at Naver.
- `opencode` — PASS (6150ms): 컨텍스트 말미에 사용자가 "네이버 출근 시작했어"라고 확인하고, 어시스턴트도 "네이버 적응 어떠세요?"라고 응답하여 현재 직장이 네이버임이 명확함.
- `codex` — PASS (9839ms): Context explicitly states the user left 카카오, started at 네이버 a month later, and is currently adapting there, so the current employer is 네이버.
- `gemini` — PASS (9031ms): 컨텍스트 후반부에 사용자가 네이버로 출근을 시작하여 적응 중이라는 사실이 명시되어 현재 직장이 네이버임을 알 수 있습니다.

### `off`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (32338ms): The context explicitly states the user has started working at Naver and is currently adapting there.
- `opencode` — PASS (10663ms): 대화 맨 끝 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어" 로 현재 직장이 네이버임이 명확하다.
- `codex` — PASS (10048ms): 문맥 후반에 사용자가 네이버 합격 후 카카오를 퇴사하고 1개월 뒤 네이버 입사를 완료해 현재 네이버에 적응 중이라고 명시되어 있어 현재 직장이 네이버임을 분명히 알 수 있다.
- `gemini` — PASS (9641ms): context explicitly states that the user joined Naver a month ago and is currently adapting to the new team.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
