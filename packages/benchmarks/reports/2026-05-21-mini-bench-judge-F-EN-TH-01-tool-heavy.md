# Mini-bench (judge ensemble) — F-EN-TH-01-tool-heavy — 2026-05-21

- **Fixture**: F-EN-TH-01-tool-heavy (tool-heavy)
- **Strategies**: reactive, reactive-vercel, realtime, anthropic-native, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)

## Ensemble verdict per strategy (majority of valid judges)

| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |
|---|---:|---:|---:|---:|---:|
| `reactive` | 1.000 | 3.0 | 1 | 1.000 | 0.500 |
| `reactive-vercel` | 0.000 | 4.0 | 0 | 1.000 | 1.000 |
| `realtime` | 1.000 | 4.0 | 0 | 1.000 | 1.000 |
| `anthropic-native` | 1.000 | 3.0 | 1 | 1.000 | 1.000 |
| `off` | 1.000 | 3.0 | 1 | 1.000 | 1.000 |

## Per-judge breakdown

### `reactive`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (3/4 valid)

- `glm` — **INFRA** (90031ms): GLM fetch failed: This operation was aborted
- `opencode` — PASS (6439ms): Context includes hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi Market, Gwangalli beach, Dongbaek Park, Centum C
- `codex` — PASS (7571ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae Beach, Jagalchi 
- `gemini` — PASS (10554ms): The context explicitly lists the hotel confirmation LCH-2026-05-23-A7Q3, the seafood reservation RES-J-A4K7, and multiple activities including Haeundae beach and Jagalchi Market.

### `reactive-vercel`

**Probe 1** (after turn 14) — ensemble: ❌ FAIL (4/4 valid)

- `glm` — FAIL (12059ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3 but lacks seafood reservation confirmation and specific activities.
- `opencode` — FAIL (8905ms): Context contains the hotel confirmation (LCH-2026-05-23-A7Q3) but is missing the seafood reservation confirmation (RES-J-A4K7) and any suggested activities beyond the Haeundae hotel location — those p
- `codex` — FAIL (8075ms): The context only includes the hotel booking confirmation LCH-2026-05-23-A7Q3 and does not contain the seafood reservation confirmation RES-J-A4K7 or a complete set of suggested activities for the full
- `gemini` — FAIL (11564ms): The context is missing the seafood reservation confirmation RES-J-A4K7 and mentions only one location (Haeundae beach) instead of the required two activities.

### `realtime`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (20367ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities including Haeundae beach, Jagalchi market, Gwangalli beach, Dongbaek Park, Centum City,
- `opencode` — PASS (7332ms): Context includes hotel confirmation LCH-2026-05-23-A7Q3 (Lotte City Hotel Haeundae, May 23–25, 290,000 KRW), seafood reservation confirmation RES-J-A4K7 (Jagalchi Market, May 23 at 12:30 for 2), and a
- `codex` — PASS (16589ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae beach, Jagalchi 
- `gemini` — PASS (10561ms): The context explicitly lists the hotel confirmation LCH-2026-05-23-A7Q3, the seafood reservation RES-J-A4K7, and activities like Haeundae beach and Jagalchi Market.

### `anthropic-native`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (17920ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities including Haeundae beach, Jagalchi market, Gwangalli beach, Dongbaek Park, Centum City,
- `opencode` — **INFRA** (8513ms): opencode reply unparseable (141 chars): 통과: 컨텍스트에는 호텔 확인 번호 LCH-2026-05-23-A7Q3, 해산물 예약 확인 번호 RES-J-A4K7, 그리고 최소 4가지 활동(해운대 해변, 자갈치 해산물 시장, 광안리 해변, 센텀시티/동백공원/BI
- `codex` — PASS (6939ms): The context explicitly includes hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae Beach, Jagalchi Seafood Market, 
- `gemini` — PASS (11595ms): The context contains the hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities including Haeundae beach and Jagalchi Market.

### `off`

**Probe 1** (after turn 14) — ensemble: ✅ PASS (3/4 valid)

- `glm` — PASS (11468ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood confirmation RES-J-A4K7, and multiple activities including Haeundae beach, Jagalchi market, Gwangalli beach, Dongbaek Park, Centum City
- `opencode` — **INFRA** (9622ms): opencode reply unparseable (139 chars): 통과: 컨텍스트는 호텔 확인 번호 LCH-2026-05-23-A7Q3, 해산물 예약 확인 번호 RES-J-A4K7, 그리고 최소 4가지 활동(해운대 해변 산책, 자갈치 해산물 시장, 광안리 해변, 동백공원, 센텀시티
- `codex` — PASS (14857ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeundae beach, Jagalchi 
- `gemini` — PASS (11289ms): The context explicitly contains the hotel confirmation LCH-2026-05-23-A7Q3, the seafood reservation RES-J-A4K7, and multiple suggested activities including Haeundae beach and Jagalchi Market.

## Caveats

- Single fixture; not statistically conclusive.
- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.
- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.
- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.
