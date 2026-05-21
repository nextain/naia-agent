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

- `glm` — PASS (12549ms): The context explicitly states the user has started working at Naver and is currently adapting to their new role there.
- `opencode` — PASS (10943ms): 컨텍스트에 "네이버 출근 시작했어. 적응 중" 및 "카카오 마지막 주야. 인수인계 중" 메시지가 포함되어 있어 사용자의 현재 고용주가 네이버임이 명확하다.
- `codex` — PASS (5673ms): 문맥에 네이버 합격 후 카카오를 떠나는 마지막 주를 거쳐 네이버 입사 완료와 적응 중이라는 최신 상태가 있어 현재 직장은 네이버라고 명확히 판단할 수 있다.
- `gemini` — PASS (15364ms): 컨텍스트에 사용자가 카카오에서 네이버로 이직하여 현재 네이버로 출근을 시작했다는 내용이 명확히 포함되어 있습니다.

### `reactive-vercel`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11800ms): The context explicitly states the user left Kakao and is now working at Naver, with updates confirming their start and adaptation at Naver.
- `opencode` — PASS (12541ms): 사용자의 마지막 메시지가 '네이버 출근 시작했어'라고 명시하고, 이후의 대화도 네이버에서의 적응을 다루고 있어, 현재 직장이 네이버라는 것을 명확히 보여준다.
- `codex` — PASS (6281ms): 문맥에 네이버 합격 후 카카오 마지막 주를 거쳐 [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했다고 명시되어 있어 현재 직장은 네이버임이 분명하다
- `gemini` — PASS (10691ms): The context explicitly shows the user moved from Kakao to Naver and stated 1 month ago that they started working at Naver and are currently adapting.

### `realtime`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (11739ms): The context clearly shows the user has started working at Naver and is currently adapting there, with previous employment at Kakao mentioned as past information.
- `opencode` — **INFRA** (14219ms): opencode reply unparseable (98 chars): 통과: 컨텍스트는 사용자가 카카오에서 인수인계를 마치고 네이버에 합류했음을 명확히 보여준다 ("네이버 출근 시작했어. 적응 중"), 현재 고용주로서 네이버를 명확히 확립한다.

- `codex` — PASS (10929ms): 문맥에 사용자가 네이버 합격 후 출근을 시작했고 적응 중이라고 명시되어 있어 현재 직장은 네이버로 판단할 수 있다.
- `gemini` — PASS (10736ms): 사용자가 1개월 전 네이버에 입사하여 출근을 시작하고 적응 중이라는 사실이 컨텍스트에 명시되어 있습니다.

### `anthropic-native`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (14005ms): The context explicitly states the user started at Naver and is currently adapting there, with no indication of returning to Kakao or working elsewhere.
- `opencode` — PASS (8267ms): 컨텍스트는 사용자가 카카오에서 근무하다가 네이버에 합격했음을 명확히 보여주며, 가장 최근 메시지에서 사용자가 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라고 확인하여, 현재 직장이 네이버임을 나타낸다.
- `codex` — PASS (6539ms): 문맥에 [1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어라고 명시되어 있어 현재 직장은 카카오에서 이직한 뒤의 네이버임을 충분히 판단할 수 있다.
- `gemini` — PASS (11262ms): The context explicitly states the user started working at Naver after leaving Kakao and is currently adapting to the new team.

### `off`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (12902ms): The context explicitly states the user started working at Naver and is currently adapting there, with no ambiguity about their current employer.
- `opencode` — PASS (7126ms): 컨텍스트는 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"를 보여주며, 이는 네이버가 현재 고용주임을 명확히 나타냅니다.
- `codex` — PASS (7690ms): 문맥에 [1개월 후 — 네이버 입사 완료]와 네이버 출근 시작했다는 최신 상태가 있어 사용자의 현재 직장은 네이버임을 명확히 알 수 있다.
- `gemini` — PASS (11692ms): The context states the user has started working at Naver after completing their final week at Kakao, explicitly mentioning they are currently adapting to the new team environment at Naver.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
