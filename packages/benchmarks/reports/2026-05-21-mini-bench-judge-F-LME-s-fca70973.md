# Mini-bench (R7 / judge ensemble) — F-LME-s-fca70973 — 2026-05-21

- **Fixture**: F-LME-s-fca70973 (longmemeval-s-single-session-preference)
- **Strategies**: pi, hermes, reactive, off
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
| `pi` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 51313 | 51070/754 |
| `hermes` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 45336 | 51161/1564 |
| `reactive` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 2 | 0/0 |
| `off` | n/a | 1.000 (n=1) | n/a | no | 4.0 | 0 | 0/0 |

Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.

## Per-judge breakdown

### `pi`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (25909ms): The context clearly states the user's interest in thrill rides, unique food experiences, and nighttime shows, references their previous park visits, and provides suggestions covering all these aspects
- `opencode` — PASS (14703ms): The context contains the user's initial message explicitly listing their previous visits to Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, along with their 
- `codex` — PASS (8267ms): The context clearly shows the user wants theme park recommendations anchored to prior visits to Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, with emphasis
- `gemini` — PASS (9498ms): The context contains the user's explicit interest in thrill rides, unique food experiences, and nighttime shows, as well as their recent visits to the four specific Southern California theme parks lis

### `hermes`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (9964ms): The context includes the user's stated interests in thrill rides, special events, unique food experiences, and nighttime shows, plus their previous experiences at the four parks, enabling a comprehens
- `opencode` — PASS (12585ms): Context contains the user's initial message listing four specific parks visited and explicitly requesting "thrill rides, unique food experiences, or nighttime shows," plus two follow-up messages drill
- `codex` — PASS (12492ms): The context clearly shows the user wants recommendations anchored to parks they already know, with emphasis on upcoming special events, thrill-oriented attractions, unique food experiences, and likely
- `gemini` — PASS (13537ms): The context explicitly lists the four parks visited and mentions the user's specific interests in thrill rides, special events, unique food, and nighttime shows.

### `reactive`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (10947ms): The context provides the user's specific interests (thrill rides, special events, unique food, nighttime shows), references their previous park experiences, and includes detailed Halloween event infor
- `opencode` — FAIL (15123ms): 컨텍스트에는 네 공원과 사용자의 초기 관심사(스릴 라이드, 음식, 야간 쇼)가 명시되어 있지만, 질문은 "또 다른" 주말을 위한 새로운 제안을 요구하고 있으며, 컨텍스트는 이전의 핼러윈 중심 논의만을 제공할 뿐, 사용자가 여러 측면(예: 스릴 라이드 전용, 가족 친화적, 특별 행사 없음)을 포괄하는 포괄적인 선호도 프로필을 명시적으로 요약하거나 제약 조건을
- `codex` — PASS (8031ms): The context explicitly shows the user wants upcoming theme park recommendations anchored to parks they already visited and is asking for thrill rides, special events, unique food, and nighttime shows,
- `gemini` — PASS (15771ms): The context explicitly lists the user's recently visited parks (Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, Universal Studios Hollywood) and their specific interests in thrill rides, uni

### `off`

**Probe 1** [tail-trivial] (after turn 487) — ensemble: ✅ PASS (4/4 valid)

- `glm` — PASS (11135ms): The context provides detailed information about Halloween events, thrill rides, unique food experiences, and nighttime shows at all four parks the user previously visited, directly addressing their st
- `opencode` — PASS (9293ms): Context shows the user explicitly mentioned visiting Disneyland, Knott's Berry Farm, Six Flags Magic Mountain, and Universal Studios Hollywood, asked about "thrill rides, unique food experiences, or n
- `codex` — PASS (10217ms): The context explicitly shows the user wants future theme park recommendations anchored to parks they recently visited, with emphasis on special events plus thrill rides, unique food experiences, and n
- `gemini` — PASS (15147ms): The context contains the user's explicit list of previously visited parks and their multiple stated interests in thrill rides, special events, unique food, and nighttime shows, which provides all the 

## Caveats (R7)

- Single fixture; not statistically conclusive.
- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.
- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.
- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.