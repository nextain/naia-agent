# Mini-bench (judge ensemble) — F-KR-KU-01-knowledge-update — 2026-05-21

- **Fixture**: F-KR-KU-01-knowledge-update (longmem-knowledge-update)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `reactive-vercel` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15201ms): The context clearly shows the user has moved from Kakao to Naver, and their statement about team atmosphere refers to their current workplace at Naver.
- `opencode` — PASS (9436ms): CONTEXT는 사용자가 카카오에서 네이버로 이직한 이력(3개월 후 합격, 1개월 후 입사 완료)과 현재 네이버에서 적응 중임을 명확히 보존하여, 현재 직장 = 네이버로 답할 수 있는 충분한 정보를 포함한다.
- `codex` — PASS (6802ms): CONTEXT explicitly says the user left Kakao, joined Naver, and has already started working there, so the current workplace is clearly Naver.
- `gemini` — PASS (13344ms): The context explicitly tracks the user's career move, showing they joined and started working at Naver (네이버 합격, 네이버 출근 시작) after leaving Kakao.

### `reactive-vercel`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (17804ms): The context clearly shows the user has transitioned from Kakao to Naver, and their statement about team atmosphere refers to their current workplace at Naver.
- `opencode` — **INFRA** (14524ms): opencode reply unparseable (149 chars): 합격: 컨텍스트는 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라는 명시적인 전환을 보여주고, 사용자의 "팀 분위기 좋아. 카카오랑은 또 다른 매력" 발언은 현재 네이버에서 카카오(이전 직장)와 비교하
- `codex` — PASS (6409ms): CONTEXT explicitly shows the user left 카카오, completed joining 네이버, and is now adapting there, so the current workplace is clearly 네이버.
- `gemini` — PASS (22823ms): The context explicitly records the user passing the Naver interview, finishing their tenure at Kakao, and currently working at Naver.

### `realtime`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (16265ms): The context clearly establishes the user has moved from Kakao to Naver, and their statement about team atmosphere refers to their current workplace at Naver.
- `opencode` — PASS (9392ms): 컨텍스트가 카카오→네이버 이직 전체 이력을 담고 있으며, 마지막 "네이버 출근 시작했어. 적응 중" 직후 "팀 분위기 좋아" 발화로 현재 직장이 네이버임이 명확하다.
- `codex` — PASS (10739ms): Context explicitly states the user passed Naver, finished their last week at Kakao, then started working at Naver, so the current workplace is clearly Naver.
- `gemini` — PASS (12906ms): The context explicitly documents the user's transition from Kakao to Naver, including starting work at Naver and comparing its atmosphere to their previous experience at Kakao.

### `anthropic-native`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15389ms): The context clearly shows the user has moved from Kakao to Naver, and their current message refers to their team at Naver, comparing it to their previous team at Kakao.
- `opencode` — PASS (7236ms): 문맥에는 사용자가 카카오에서 네이버로 이직하여 현재 재직 중이라는 내용이 "[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어"라는 메시지와 "팀 분위기 좋아. 카카오랑은 또 다른 매력"이라는 후속 메시지를 통해 분명하게 나와 있습니다.
- `codex` — PASS (5628ms): Context explicitly states the user passed Naver, started work there a month later, and then describes current team 분위기, so the current employer is clearly 네이버.
- `gemini` — PASS (22739ms): The context explicitly tracks the user's transition from Kakao to Naver and confirms they have started working at Naver as of one month ago.

### `off`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (90049ms): GLM fetch failed: This operation was aborted
- `opencode` — PASS (10304ms): 컨텍스트에 “[1개월 후 — 네이버 입사 완료] 네이버 출근 시작했어”와 이후 대화가 사용자의 현재 고용주를 네이버로 명확히 확인해 주며, 카카오는 이전 직장입니다.
- `codex` — PASS (14008ms): Context explicitly states the user left Kakao, joined Naver a month later, and then described current team atmosphere at Naver, so the current workplace is clearly Naver.
- `gemini` — PASS (30508ms): The context explicitly states the user joined Naver and is currently adapting to its team atmosphere, clearly distinguishing it from their previous workplace, Kakao.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
