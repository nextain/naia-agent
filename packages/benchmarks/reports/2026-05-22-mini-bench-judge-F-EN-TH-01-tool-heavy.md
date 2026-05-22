# Mini-bench (R7 / judge ensemble) — F-EN-TH-01-tool-heavy — 2026-05-22

- **Fixture**: F-EN-TH-01-tool-heavy (tool-heavy)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 2 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 2 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 1.000 (n=2) | n/a | no | 4.0 | 5241 | 694/340 |
| `hermes` | n/a | 1.000 (n=2) | n/a | no | 4.0 | 10027 | 981/539 |
| `reactive` | n/a | 1.000 (n=2) | n/a | no | 4.0 | 1 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=2) | n/a | no | 4.0 | 10657 | 533/278 |
| `off` | n/a | 1.000 (n=2) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13115ms): Context includes hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi market, Gwangalli, Dongbaek Park, Centum City, B
- `opencode` — PASS (20764ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi Market, Gwangalli beach, Dongbaek Park, Centum C
- `codex` — PASS (5850ms): The context explicitly includes the booked Lotte City Hotel confirmation LCH-2026-05-23-A7Q3, the Jagalchi seafood reservation confirmation RES-J-A4K7, and multiple suggested activities such as Haeund
- `gemini` — PASS (12673ms): The tail contains both confirmation numbers (LCH-2026-05-23-A7Q3 and RES-J-A4K7) and a list of suggested activities including Haeundae beach, Jagalchi market, and Gwangalli.

**Probe 2** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (66082ms): The recap section explicitly states Saturday's weather as "sunny, high 24°C" which satisfies the requirement for both 'sunny' and '24°C'.
- `opencode` — PASS (18671ms): Context contains the Saturday Busan forecast in both the recap ("Saturday: sunny, high 24°C low 18°C") and the tail tool_result, providing unambiguous access to "sunny" and "24°C".
- `codex` — PASS (5499ms): The recap and tail both explicitly state Busan's Saturday forecast as sunny with a high of 24°C, which directly supports answering the question with Saturday sunny, 24°C.
- `gemini` — PASS (11794ms): The context explicitly states the Saturday weather for Busan as sunny with a high of 24°C and a low of 18°C in both the Critical Context and the tool results.

### `hermes`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9336ms): Context includes hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi market, Gwangalli, etc.).
- `opencode` — PASS (11495ms): Context contains all three required elements — hotel confirmation LCH-2026-05-23-A7Q3 (tool result in tail), seafood reservation confirmation RES-J-A4K7 (tool result in tail), and multiple activities 
- `codex` — PASS (6673ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities including Haeundae Beach, Jagalch
- `gemini` — PASS (11905ms): The context contains the hotel booking confirmation (LCH-2026-05-23-A7Q3), the seafood reservation confirmation (RES-J-A4K7), and multiple activities (Haeundae beach, Jagalchi Market, Gwangalli beach)

**Probe 2** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11647ms): The context explicitly states Saturday's weather forecast as "sunny, high 24°C low 18°C" in multiple places within the recap section.
- `opencode` — PASS (12839ms): The recap's Completed Actions, Resolved Questions, and Critical Context all explicitly state Saturday's Busan forecast as sunny with a high of 24°C.
- `codex` — PASS (6761ms): The context explicitly states the original Busan Saturday forecast multiple times as sunny with a high of 24°C, which is exactly the fact the agent would need to answer.
- `gemini` — PASS (12262ms): The context explicitly states in the recap and tail that Saturday's weather in Busan is sunny with a high of 24°C and a low of 18°C.

### `reactive`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9044ms): Context includes hotel confirmation LCH-2026-05-23-A7Q3, seafood confirmation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi market, Gwangalli, etc.).
- `opencode` — PASS (8852ms): Context includes hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation confirmation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi Market, Gwangalli beach, Dongbaek Park, Centum C
- `codex` — PASS (6713ms): The context explicitly gives the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities including Haeundae Beach, Jagalchi M
- `gemini` — PASS (10614ms): The context contains the hotel confirmation (LCH-2026-05-23-A7Q3), the seafood reservation (RES-J-A4K7), and multiple suggested activities like Haeundae beach and Jagalchi Market.

**Probe 2** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (6107ms): The context includes the tool result stating "Saturday: sunny, high 24°C low 18°C" within the recap range (turns 0..8).
- `opencode` — PASS (17666ms): Context clearly states "Saturday: sunny, high 24°C low 18°C" in both the recap tool_result and the tail assistant text, providing unambiguous access to both "sunny" and "24°C".
- `codex` — PASS (6531ms): The context explicitly preserves the original Busan forecast in both the recap and tail as Saturday sunny with a high of 24°C (tool result also includes low 18°C), which is sufficient to answer the qu
- `gemini` — PASS (10212ms): The context explicitly states in both the tool results and the assistant's summaries that Saturday's forecast is sunny with a high of 24°C.

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10443ms): The context contains both confirmation numbers (LCH-2026-05-23-A7Q3 for hotel and RES-J-A4K7 for seafood reservation) and multiple activities (Haeundae beach, Jagalchi market, Gwangalli beach, Dongbae
- `opencode` — PASS (8147ms): The context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities (Haeundae beach, Jagalchi Market, Gwangalli beach, Dongbaek Park, Centum City, BIFF
- `codex` — PASS (5842ms): The context explicitly includes the hotel booking confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities including Haeundae Beach, Jagalch
- `gemini` — PASS (10975ms): The context contains the hotel confirmation (LCH-2026-05-23-A7Q3), the seafood reservation (RES-J-A4K7), and a list of specific activities including Haeundae beach and Jagalchi Market.

**Probe 2** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11030ms): The context clearly states Saturday's forecast was sunny with a high of 24°C, satisfying the requirement for both 'sunny' and temperature details.
- `opencode` — PASS (11409ms): Both the recap and tail contain the Saturday forecast — "sunny with a high of 24°C" — providing unambiguous information satisfying both required elements ('sunny'/'Saturday' and '24°C').
- `codex` — PASS (5832ms): The context explicitly states that Busan’s Saturday forecast was sunny with a high of 24°C, both in the recap and the tail tool result/assistant reply.
- `gemini` — PASS (10134ms): Both the recap and the conversation tail explicitly state that Saturday's forecast is sunny with a high of 24°C.

### `off`

**Probe 1** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (19282ms): Context contains both confirmation numbers (LCH-2026-05-23-A7Q3 and RES-J-A4K7) and multiple activities (Haeundae beach, Jagalchi market, Gwangalli, Dongbaek Park, Centum City, BIFF Square).
- `opencode` — PASS (9235ms): Context contains hotel confirmation LCH-2026-05-23-A7Q3, seafood reservation RES-J-A4K7, and multiple activities (Haeundae beach walk, Jagalchi Seafood Market, Gwangalli beach, Dongbaek Park, Centum C
- `codex` — PASS (5798ms): The context explicitly provides the hotel confirmation LCH-2026-05-23-A7Q3, the seafood reservation confirmation RES-J-A4K7, and multiple suggested activities including Haeundae Beach, Jagalchi Seafoo
- `gemini` — PASS (12957ms): The context explicitly provides the hotel confirmation (LCH-2026-05-23-A7Q3), the seafood reservation confirmation (RES-J-A4K7), and multiple suggested activities like Haeundae beach and Jagalchi Mark

**Probe 2** [tail-trivial] (after turn 19) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (15258ms): The context contains the specific Saturday weather forecast (sunny, high 24°C) from both the tool result and assistant response.
- `opencode` — PASS (6474ms): The context includes the tool_result "Saturday: sunny, high 24°C low 18°C" and the assistant's restatement "Saturday will be sunny with a high of 24°C", supplying both required facts ('sunny' and '24°
- `codex` — PASS (5296ms): The context explicitly states the original Busan Saturday forecast as sunny with a high of 24°C (and low 18°C), both in the weather tool result and the assistant's summary.
- `gemini` — PASS (48130ms): The context explicitly contains the weather tool result for Busan stating Saturday will be sunny with a high of 24°C and a corresponding assistant message confirming these details.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.