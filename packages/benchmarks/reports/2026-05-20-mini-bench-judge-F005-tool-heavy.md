# Mini-bench (judge ensemble) — F005-tool-heavy — 2026-05-20

- **Fixture**: F005-tool-heavy (tool-heavy)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 1.000 | 1.000 |
| `realtime` | 1.000 | 3.0 | 1 | 1.000 | 1.000 |
| `anthropic-native` | 1.000 | 2.0 | 2 | 0.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 20) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (36593ms): GLM reply unparseable: 
- `opencode` — PASS (7683ms): Response reports the 3 new test files (logout, session, middleware), 15 total tests passing, and all 4 source files now covered.
- `codex` — PASS (5223ms): The response states that 3 new test files were created, all 15 tests passed, and coverage expanded to all 4 source files.
- `gemini` — PASS (11423ms): The assistant's summary correctly identifies the 3 new test files, the total of 15 passing tests, and the resulting coverage of all 4 source files.

### `realtime`

**Probe 1** (after turn 20) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (4526ms): GLM reply unparseable: 
- `opencode` — PASS (5577ms): The response clearly documents 3 new test files created (logout, session, middleware), reports 15 total tests passing (4+2+5+4), and confirms all 4 source files are now covered.
- `codex` — PASS (5935ms): The response states that 3 new test files were created, all 15 tests passed, and coverage now includes all 4 source files.
- `gemini` — PASS (22483ms): The assistant accurately summarizes the creation of 3 new test files, the resulting 15 total tests, and the extension of coverage to all 4 source files.

### `anthropic-native`

**Probe 1** (after turn 20) — ensemble: ✅ PASS (2/4 valid)

- `glm` — **INFRA** (6855ms): GLM reply unparseable: 
- `opencode` — **INFRA** (6814ms): opencode reply unparseable (118 chars): 통과: 응답은 정확히 3개의 새로운 테스트 파일(logout, session, middleware)을 만들고, 15개의 테스트가 모두 통과되었으며(4+2+5+4), 4개의 소스 파일 모두 커버리지를 확인합니다.

- `codex` — PASS (7166ms): It correctly states that 3 new test files were created, 15 tests passed in total, and coverage now includes all 4 source files.
- `gemini` — PASS (24163ms): The assistant correctly identifies the creation of 3 new test files, the total of 15 passing tests, and the coverage of all 4 source files.

### `off`

**Probe 1** (after turn 20) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (4681ms): GLM reply unparseable: 
- `opencode` — PASS (6197ms): Assistant created 3 new test files (logout, session, middleware), confirmed 15 total tests passing, and reported all 4 source files (oauth, logout, session, middleware) as covered.
- `codex` — PASS (6574ms): It correctly states that 3 new test files were created, there are 15 total passing tests, and all 4 source files are now covered.
- `gemini` — PASS (15270ms): The assistant accurately summarized the creation of three new test files, the achievement of fifteen passing tests, and the extension of coverage to all four source files.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
