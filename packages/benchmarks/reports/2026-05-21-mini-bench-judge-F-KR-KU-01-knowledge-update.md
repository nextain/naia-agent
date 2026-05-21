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
| `realtime` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21368ms): The context clearly shows the user has started working at Naver and is currently adapting there, with previous employment at Kakao mentioned as past information.
- `opencode` — PASS (15721ms): 컨텍스트에 사용자가 카카오에서 네이버로 이직했으며, "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어" 및 "팀 분위기 좋아" 메시지를 통해 현재 네이버에서 근무 중임이 명확히 나타납니다.
- `codex` — PASS (9329ms): CONTEXT explicitly states 네이버 합격 후 다음달 출근, then 네이버 입사 완료 and currently adapting there, while 카카오는 마지막 주였다고만 나와 현재 직장은 네이버로 판단 가능하다.
- `gemini` — PASS (12416ms): The context explicitly states the user started working at Naver after finishing their last week at Kakao, satisfying the current employer requirement.

### `reactive-vercel`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (39151ms): The context clearly shows the user has transitioned from Kakao to Naver and is currently working at Naver as confirmed in the most recent updates.
- `opencode` — PASS (13213ms): 컨텍스트에 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"와 "팀 분위기 좋아. 카카오랑은 또 다른 매력"이 포함되어 있어, 사용자의 현재 직장이 네이버임이 명확히 드러난다.
- `codex` — PASS (16102ms): 문맥에 사용자가 카카오에서 퇴사 인수인계를 마치고 [1개월 후 — 네이버 입사 완료] 네이버 출근을 시작했다고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (9906ms): 컨텍스트의 마지막 대화에서 사용자가 네이버에 입사하여 출근을 시작했고 적응 중이라고 명시하고 있으므로 현재 직장이 네이버임을 명확히 알 수 있다.

### `realtime`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (12560ms): The context clearly shows the user has transitioned from Kakao to Naver and is currently working at Naver, as evidenced by their statements about starting work at Naver and being in the adaptation pha
- `opencode` — **INFRA** (14553ms): opencode reply unparseable (155 chars): 통과: 컨텍스트는 사용자가 카카오에서 마지막 주를 보냈고("카카오 마지막 주야"), 네이버에 합격했으며("네이버 합격해서 다음달부터 출근해"), 현재 네이버에서 일하기 시작했다("네이버 출근 시작했어. 적응 중")는
- `codex` — PASS (8431ms): 문맥에 네이버 합격 후 카카오를 떠나 인수인계를 마쳤고 이어서 네이버 출근을 시작해 적응 중이라고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (10102ms): 컨텍스트 내 '[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어' 및 '네이버 적응 어떠세요?' 등의 발화를 통해 사용자의 현재 직장이 네이버임을 명확히 확인할 수 있다.

### `anthropic-native`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (22881ms): The context clearly shows the user has transitioned from Kakao to Naver and is currently working at Naver, as evidenced by their mention of starting work at Naver, completing their transition, and ada
- `opencode` — PASS (17316ms): CONTEXT의 마지막 부분에서 사용자가 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라고 명시하여 현재 직장이 네이버임이 명확하다.
- `codex` — PASS (8762ms): 문맥 후반에 사용자가 [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어라고 명시해 현재 직장은 카카오에서 이직한 뒤의 네이버임이 충분히 드러난다
- `gemini` — PASS (9273ms): 사용자가 네이버 합격 후 출근을 시작하여 적응 중이라고 언급한 대화 내용이 명시되어 있어 현재 직장이 네이버임을 명확히 알 수 있다.

### `off`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12560ms): The context clearly shows the user has transitioned from Kakao to Naver and is currently working at Naver.
- `opencode` — PASS (19145ms): 컨텍스트는 사용자가 카카오에서 네이버로 이직했음을 명확히 보여주며, 가장 최근 메시지인 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"와 "팀 분위기 좋아. 카카오랑은 또 다른 매력"을 통해 현재 고용주로 네이버를 확인한다.
- `codex` — PASS (15211ms): 문맥에 사용자가 카카오에서 퇴사 절차를 거쳐 [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했다고 명시되어 있어 현재 직장은 네이버다.
- `gemini` — PASS (9276ms): The context explicitly states the user started working at Naver one month ago and is currently adjusting to the new team atmosphere.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
