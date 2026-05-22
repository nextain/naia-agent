# Mini-bench (R7 / judge ensemble) — F-LME-s-fca70973 — 2026-05-22

- **Fixture**: F-LME-s-fca70973 (longmemeval-s-single-session-preference)
- **Strategies**: pi, hermes, reactive, naia+llm, off
- **Probes**: 1 task-accuracy
- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)
- **Config**: keepTail=10, contextCap=16000 chars, targetTokens=1000

## Probe stress classification

| Stress class | Count | Meaning |
|---|---:|---|
| recap-only | 0 | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |
| tail-trivial | 1 | Fact lives in preserved tail — answerable without compaction effort |
| no-compaction | 0 | No compactionPoint reached — measures context-cap only |
| unclassified | 0 | Probe lacks `factTurns` — cannot determine stress |

## Ensemble verdict per strategy

| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pi` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 10106 | 54624/293 |
| `hermes` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 50360 | 54721/3544 |
| `reactive` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 3 | 0/0 |
| `naia+llm` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 20788 | 629/925 |
| `off` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9392ms): The context explicitly covers thrill rides, special events (Halloween/Holiday), unique food experiences, and references all four previously visited parks, matching the user's multi-faceted preferences
- `opencode` — PASS (15402ms): The context shows the user visited Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, explicitly requested "thrill rides, unique food experiences, or nighttime 
- `codex` — PASS (7489ms): The context clearly shows the user wants recommendations anchored to Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, with emphasis on thrill rides, special e
- `gemini` — PASS (15859ms): The context explicitly shows the user's previous visits to the four specific parks and their stated interest in a combination of thrill rides, unique food experiences, nighttime shows, and seasonal ev

### `hermes`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (13796ms): The context shows the assistant has already provided comprehensive theme park suggestions that cater to the user's interests in thrill rides, special events, unique food experiences, and nighttime sho
- `opencode` — FAIL (34242ms): The context contains the user's park visits and stated interests (thrill rides, food, nighttime shows), but the criterion demands a highly specific synthesized preference profile including negative pr
- `codex` — PASS (6093ms): The context explicitly shows the user wants theme park recommendations framed by prior visits to Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, with emphasi
- `gemini` — PASS (15039ms): The context explicitly lists the four reference parks visited and the user's stated interests in thrill rides, special events like Halloween, unique food experiences, and nighttime shows.

### `reactive`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (33681ms): The context explicitly references the user's previous park visits, their stated interest in thrill rides and special events, and provides detailed information about unique food experiences and nightti
- `opencode` — PASS (22880ms): The context contains the user's stated interest in "thrill rides, unique food experiences, or nighttime shows," their visits to the four named parks (Disneyland, Knott's Berry Farm, Six Flags Magic Mo
- `codex` — PASS (7680ms): The context explicitly shows the user wants future theme park suggestions informed by their visits to Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, with em
- `gemini` — PASS (12289ms): The context explicitly records the user's interest in thrill rides, unique food, and nighttime shows at four specific parks (Disneyland, Knott's, Six Flags, Universal), with a proven focus on Hallowee

### `naia+llm`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (55063ms): The context contains detailed information about Halloween events, food experiences, and special offerings at the four theme parks the user previously visited, covering both thrill rides and special ev
- `opencode` — PASS (18778ms): The user's first message explicitly lists their experience at Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, and asks about "thrill rides, unique food exper
- `codex` — PASS (7351ms): The context shows the user wants theme park recommendations anchored to parks they have already visited, explicitly asks for upcoming special events plus thrill rides, unique food experiences, and nig
- `gemini` — PASS (71046ms): The context contains the user's previous park visits and specific interests in thrill rides, special events (Halloween), unique food, and nighttime shows, allowing an agent to determine their preferen

### `off`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10528ms): The context clearly establishes the user's preference for thrill rides, special events, unique food experiences, and nighttime shows based on their previous visits to Disneyland, Knott's Berry Farm, S
- `opencode` — FAIL (18790ms): The context contains the user's visited parks and interests in thrill rides, food experiences, and nighttime shows, but the criterion requires a comprehensive negative-preference articulation (what th
- `codex` — PASS (8601ms): The context clearly shows the user wants theme park recommendations anchored to prior visits to Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, with explicit
- `gemini` — PASS (14848ms): The context explicitly lists the user's previous visits to the four specific theme parks and their stated interests in thrill rides, unique food experiences, nighttime shows, and Halloween events.

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.