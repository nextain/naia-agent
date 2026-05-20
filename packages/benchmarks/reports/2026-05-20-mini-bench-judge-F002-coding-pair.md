# Mini-bench (judge ensemble) — F002-coding-pair — 2026-05-20

- **Fixture**: F002-coding-pair (coding-pair)
- **Strategies**: reactive, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Deterministic task | Deterministic recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 0.000 | 0.000 |
| `realtime` | 1.000 | 2.0 | 2 | 0.000 | 0.000 |
| `anthropic-native` | 0.000 | 2.0 | 2 | 0.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 0.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 22) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (5493ms): GLM reply unparseable: 
- `opencode` — PASS (7203ms): The response lists all three file paths (packages/auth/src/oauth.ts, packages/auth/src/__tests__/oauth.test.ts, packages/auth/src/logout.ts) verbatim and references both PKCE (verifier + code_verifier
- `codex` — PASS (7182ms): It verbatim includes packages/auth/src/oauth.ts, packages/auth/src/__tests__/oauth.test.ts, and packages/auth/src/logout.ts, and explicitly mentions PKCE verifier plus a state CSRF check.
- `gemini` — PASS (16887ms): The response correctly identifies all three file paths and the PKCE/CSRF security measures specified in the pass criterion.

### `realtime`

**Probe 1** (after turn 22) — ensemble: ✅ PASS (2/4 valid)

- `glm` — **INFRA** (4288ms): GLM reply unparseable: 
- `opencode` — **INFRA** (7074ms): opencode reply unparseable (196 chars): 통과: 세 가지 파일 경로(`packages/auth/src/oauth.ts`, `packages/auth/src/__tests__/oauth.test.ts`, `packages/auth/src/logout.ts`)
- `codex` — PASS (7327ms): It lists packages/auth/src/oauth.ts, packages/auth/src/__tests__/oauth.test.ts, and packages/auth/src/logout.ts verbatim and explicitly mentions PKCE verifier plus state CSRF checking.
- `gemini` — PASS (18929ms): The response includes all three file paths verbatim and mentions both the PKCE verifier and the state CSRF check as required.

### `anthropic-native`

**Probe 1** (after turn 22) — ensemble: ❌ FAIL (2/4 valid)

- `glm` — **INFRA** (5054ms): GLM reply unparseable: 
- `opencode` — FAIL (7118ms): The response contains the three file paths (oauth.ts, oauth.test.ts, logout.ts) and references PKCE and state CSRF throughout the conversation, but does not present them together as a summary of key f
- `codex` — PASS (7690ms): It lists the three file paths packages/auth/src/oauth.ts, packages/auth/src/__tests__/oauth.test.ts, and packages/auth/src/logout.ts verbatim and includes the PKCE and state CSRF design decisions.
- `gemini` — **INFRA** (61969ms): gemini timed out after 60000ms

### `off`

**Probe 1** (after turn 22) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (4904ms): GLM reply unparseable: 
- `opencode` — PASS (6582ms): The response lists all three file paths verbatim — `packages/auth/src/oauth.ts`, `packages/auth/src/__tests__/oauth.test.ts`, and `packages/auth/src/logout.ts` — and references the PKCE design (code_v
- `codex` — PASS (7383ms): It correctly names packages/auth/src/oauth.ts, packages/auth/src/__tests__/oauth.test.ts, and packages/auth/src/logout.ts, and it references both PKCE and the state-based CSRF protection design.
- `gemini` — PASS (48010ms): The response correctly lists all three file paths verbatim and includes the required references to the PKCE and state CSRF design decisions.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
