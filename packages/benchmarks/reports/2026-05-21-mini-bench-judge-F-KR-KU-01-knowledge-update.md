# Mini-bench (judge ensemble) — F-KR-KU-01-knowledge-update — 2026-05-21

- **Fixture**: F-KR-KU-01-knowledge-update (longmem-knowledge-update)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `reactive-vercel` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11692ms): The context clearly shows the user has transitioned from Kakao to Naver and is currently working at Naver, as evidenced by messages about starting at Naver, adapting there, and discussing the team atm
- `opencode` — PASS (7669ms): 컨텍스트에 사용자가 카카오에서 퇴사하고 네이버에 입사하여 현재 적응 중이라는 이력("네이버 출근 시작했어", "카카오 마지막 주야", "팀 분위기 좋아")이 명확히 나타나, 현재 직장이 네이버임을 충분히 파악할 수 있다.
- `codex` — PASS (9535ms): 문맥에 사용자가 네이버 합격 후 카카오를 퇴사하고 네이버 출근을 시작했다고 명시되어 있어 현재 직장은 네이버라고 판단할 수 있다.
- `gemini` — PASS (11302ms): The context explicitly states the user has started working at Naver and is comparing the atmosphere to their previous company, Kakao.

### `reactive-vercel`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15987ms): The context explicitly states the user started at �이버 (Naver) after leaving 카카오 (Kakao), with the latest update confirming 네이버 employment and adaptation.
- `opencode` — PASS (7751ms): 컨텍스트에 "네이버 출근 시작했어", "네이버 적응 어떠세요?" 등 사용자가 카카오에서 네이버로 이직하여 현재 네이버에 재직 중임이 명확히 표시되어 있다.
- `codex` — PASS (7526ms): 문맥에 사용자가 과거 카카오에서 일하다가 네이버 합격 후 입사 완료했고 네이버 출근을 시작했다고 명시되어 있어 현재 직장은 네이버로 판단할 수 있다.
- `gemini` — PASS (8996ms): 사용자가 1개월 전 네이버 출근을 시작하여 현재 적응 중이라는 사실이 명시되어 있어 네이버가 현재 직장임을 알 수 있다.

### `realtime`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11935ms): The context explicitly states the user started working at 네이버 and is currently adapting there, with no indication they still work at 카카오.
- `opencode` — PASS (6221ms): 컨텍스트는 “[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어”와 “팀 분위기 좋아. 카카오랑은 또 다른 매력”을 보여주어, 네이버가 현재 직장이고 카카오가 이전 직장임을 명확히 나타냅니다.
- `codex` — PASS (7364ms): 문맥에 사용자가 카카오에서 마지막 주를 보내고 네이버에 합격해 다음달 출근한 뒤 네이버 입사를 완료해 현재 적응 중이라고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (10669ms): 사용자가 1개월 전 네이버 출근을 시작하여 현재 적응 중이며 팀 분위기가 좋다고 언급한 대화 내용이 명시되어 있다.

### `anthropic-native`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (17978ms): The context clearly states the user has moved from Kakao to Naver and is currently adapting to their new role at Naver.
- `opencode` — PASS (9990ms): CONTEXT에서 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어. 적응 중."과 "팀 분위기 좋아. 카카오랑은 또 다른 매력." 대화가 사용자의 현재 직장을 네이버로 명확히 나타낸다.
- `codex` — PASS (9123ms): 문맥에 사용자가 카카오를 퇴사하고 네이버에 합격해 다음달 출근한 뒤 [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했다고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (10019ms): The context explicitly states 입사 완료 and 네이버 출근 시작했어 which confirms the user is currently working at Naver.

### `off`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9794ms): The context clearly states the user transitioned from Kakao to Naver and is currently working at Naver, as confirmed by their latest update about starting at Naver and adapting there.
- `opencode` — PASS (8491ms): 대화 후반부에 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"와 "카카오랑은 또 다른 매력"이라는 발언이 사용자의 현재 직장이 네이버임을 명확히 나타낸다.
- `codex` — PASS (9319ms): 컨텍스트 후반에 사용자가 네이버 합격 후 카카오 마지막 주를 거쳐 [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했다고 명시되어 있어 현재 직장은 네이버로 판단할 수 있다.
- `gemini` — PASS (9556ms): The context explicitly records that the user has started working at Naver after leaving Kakao and is currently in the process of adjusting to the new role.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
