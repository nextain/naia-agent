# Mini-bench (judge ensemble) — F-KR-KU-01-knowledge-update — 2026-05-20

- **Fixture**: F-KR-KU-01-knowledge-update (longmem-knowledge-update)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `anthropic-native` | 1.000 | 4.0 | 0 | 0.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13446ms): The context clearly shows the user has moved from Kakao to Naver, making Naver the current workplace when they mention team atmosphere.
- `opencode` — FAIL (5994ms): 컨텍스트에는 이력(카카오→네이버 이직)은 있으나, 현재 직장이 네이버임을 명시적으로 짚어주는 '응답'이 없고 assistant는 긍정적 확인만 했을 뿐 현재 직장명을 포함한 답변을 제공하지 않았다.
- `codex` — PASS (6280ms): CONTEXT explicitly says the user passed Naver, started work there, and is now adapting after starting, so the current workplace is clearly 네이버 while 카카오는 previous job.
- `gemini` — PASS (10384ms): The context explicitly tracks the user's transition from Kakao to Naver, culminating in the user stating they have started working at Naver and are currently adjusting there.

### `realtime`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9848ms): The context establishes the user has moved from Kakao to Naver, and their statement about team atmosphere clearly refers to their current workplace at Naver.
- `opencode` — PASS (9671ms): 컨텍스트에 "네이버 합격", "카카오 마지막 주…인수인계", "네이버 출근 시작했어" 순으로 이직 이력이 명확히 기록되어 있어 현재 직장이 네이버임을 충분히 파악할 수 있다.
- `codex` — PASS (5928ms): Context explicitly says the user already started working at 네이버 after leaving 카카오, so the current workplace is clearly 네이버.
- `gemini` — PASS (15471ms): The context explicitly records the user's successful transition from Kakao to Naver and their confirmation of having started work at Naver.

### `anthropic-native`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (21493ms): The context clearly shows the user has transitioned from Kakao to Naver, and their most recent message is about their current team at Naver.
- `opencode` — FAIL (5345ms): CONTEXT에는 사용자의 네이버 합격 및 입사 사실이 대화에 포함되어 있으나, 마지막 assistant 응답이 단순히 "긍정적이네요. 좋습니다."로 끝나며, 현재 직장이 네이버임을 명시적으로 답변하지 않았습니다.
- `codex` — PASS (6056ms): Context explicitly states the user left Kakao, started at Naver a month later, and then says the team atmosphere is good there, so the current workplace is clearly 네이버.
- `gemini` — PASS (18453ms): The context clearly documents the user's transition from Kakao to Naver, including confirmation of passing the Naver interview and starting work there one month ago.

### `off`

**Probe 1** (after turn 28) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (9594ms): The context clearly establishes the user transitioned from Kakao to Naver, with the final message referring to their current team at Naver.
- `opencode` — **INFRA** (9858ms): opencode reply unparseable (103 chars): 통과: 문맥에 "네이버 합격해서 다음달부터 출근해" 및 "네이버 출근 시작했어"와 최근 메시지 "팀 분위기 좋아"가 명확하게 포함되어 있어, 사용자의 현재 직장을 네이버로 확립합니다.

- `codex` — PASS (5704ms): Context explicitly states the user passed Naver, started work there a month later, and then describes current team atmosphere, so the current workplace is clearly 네이버, with 카카오는 past employment.
- `gemini` — PASS (14266ms): The context explicitly records the user's successful move from Kakao to Naver, including starting work at Naver one month prior to the current turn.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
