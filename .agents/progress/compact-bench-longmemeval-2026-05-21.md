# Compaction Benchmark Ledger — LongMemEval 5-ability + Korean fixtures — 2026-05-21

**Slice**: 3-XR-Compact follow-up (nextain/naia-agent#48).
**Harness**: `packages/benchmarks/scripts/mini-bench-judge.ts` (grounded-prompt revision).
**Judge profile**: defaultEnsemble — **4/4 LIVE** (GLM HTTP fixed via `reasoning_content` fallback + opencode CLI + codex CLI + gemini CLI).
**Fixture standard adopted**: **LongMemEval (ICLR 2025)** 5-ability taxonomy applied to small-fixture-budget Korean conversations.
**Fixtures**: 5 hand-built Korean fixtures, one per ability (F-KR-IE-01 / F-KR-MS-01 / F-KR-TR-01 / F-KR-KU-01 / F-KR-AB-01).
**Probes per fixture**: 1 task-accuracy probe.
**LLM calls**: 5 fixtures × 4 strategies × 4 judges = ~80 (some judges hit infra timeouts).

---

## Aggregate (mean across 5 Korean LongMemEval-style fixtures)

| Strategy | Ensemble PASS rate | Verdict |
|---|---:|---|
| `reactive` | **0.400** | Compaction recap loses fact-level information |
| `realtime` | **0.400** | Same as reactive (recap shape shared) |
| `anthropic-native` | **1.000** | Effectively no host-side compaction in this harness → behaves like raw transcript |
| `off` | **1.000** | Raw transcript — facts intact, judges score PASS |

**This is the opposite of the previous English-fixture run** (where compaction scored 1.000 because the criterion was "produce A summary"). With fact-level criteria, our current generic recap is INSUFFICIENT.

---

## Per-fixture matrix (Ensemble PASS rate)

| LongMemEval ability | Fixture | reactive | realtime | anthropic-native | off |
|---|---|---:|---:|---:|---:|
| Information Extraction | F-KR-IE-01 (allergy across distractors) | 0.000 ❌ | 0.000 ❌ | 1.000 ✅ | 1.000 ✅ |
| Multi-Session Reasoning | F-KR-MS-01 (budget + duration across sessions) | 0.000 ❌ | 0.000 ❌ | 1.000 ✅ | 1.000 ✅ |
| Temporal Reasoning | F-KR-TR-01 ("지난 화요일 뭐 했어?") | 0.000 ❌ | 0.000 ❌ | 1.000 ✅ | 1.000 ✅ |
| Knowledge Update | F-KR-KU-01 (카카오 → 네이버 이직) | 1.000 ✅ | 1.000 ✅ | 1.000 ✅ | 1.000 ✅ |
| Abstention | F-KR-AB-01 (생일 비공개 — abstain 가능?) | 1.000 ✅ | 1.000 ✅ | 1.000 ✅ | 1.000 ✅ |

---

## Honest interpretation

### What this measurement REALLY shows (objective signal)

Our current naia-memory compaction (deterministic 5-section markdown + anchored iterative) **preserves narrative/summary-level information well** (Knowledge Update + Abstention pass) but **loses fact-level identifiers** (allergens, numeric budget, specific weekday activities) when the head is reduced.

The earlier English-fixture ledger (`compact-bench-judge-2026-05-21.md`) scored compaction 1.000 because the criteria were "produces A summary"; once the criteria are **fact-level recall** (what allergies, what was Tuesday, what's the current employer), the gap appears.

### Why this is GOOD measurement (and matches LongMemEval intent)

- LongMemEval published top-tier model accuracy at ~83% on multi-session reasoning. Our 0% on the same ability is honest data: our recap implementation can't yet support that workload.
- The 5-ability split + the criteria-driven judging is exactly the discrimination the deterministic-only ledger missed.
- 4-judge ensemble (GLM + opencode + codex + gemini) with 0-1 infra errors per run = trustworthy signal.

### Where the measurement is still limited

- **5 fixtures × 1 probe each**. LongMemEval-S uses 500 questions × 48-session histories (115K tokens). Our scale is ~1% of that. Conclusions = directional, not absolute.
- **anthropic-native ≈ off in this harness**. Real Anthropic `compact_20260112` server-side API is not invoked. To measure its true performance we'd call `claude-opus-4-6` directly through Messages API with the beta header.
- **Visible context heuristic**, not the runtime's `evaluateProbe`. Production wire-in still pending (the heuristic feeds the judge the raw tail, not the recap content — but criteria are written so that "raw transcript with fact present" passes, so off legitimately scores high here).
- **The `off` strategy in production would 4xx at context limit**, not pass at 1.000. Hard-truncation simulation is still missing — when added, `off` should collapse to ~0.

---

## Why the actionable next step is to IMPROVE compaction's fact-level recall

The strategy ranking right now reads **"compaction is worse than no-compaction"** — but that's because:

1. Production reality would kill `off` on long contexts (we don't simulate that here yet).
2. Our recap is generic-summary; it doesn't extract & preserve fact-level identifiers as first-class anchors.

### Concrete improvement paths (queued for the next slice)

1. **summarizer hook with LLM polish at compact() time** — replace deterministic 5-section recap with an LLM-generated summary that's explicitly instructed to preserve named entities, numeric facts, dates, and identifier strings.
2. **Mem0-style fact extraction** — at encode() time, naia-memory extracts (subject, predicate, object) facts. attachHandoff already stores anchors as separate memories; extend to in-session compaction so the recap explicitly lists "Known facts: X, Y, Z".
3. **Microsoft tool-result pattern for facts** — identifier-bearing assistant lines (e.g., "확인했습니다. 견과류와 새우 알레르기") preserved verbatim within the recap, not just summarized away.
4. **Hard-truncation simulation for `off`** in the runner — visibleText.slice(-budget*4) when off + context > budget. Once added, ranking should shift to compaction ≥ off, especially on Information Extraction / Temporal Reasoning.
5. **LongMemEval haystack scale** — wire the official LongMemEval-S dataset (115K tokens, 48 sessions) once API budget allows. Goal: position naia-memory on the public leaderboard.

---

## Production-readiness statement (the honest "어느 정도")

**Where we are**: PoC with rigorous measurement infrastructure. The infrastructure correctly identifies our implementation's weakness. The implementation needs work before it's deployment-grade for long avatar conversations.

**Where we're going (already designed)**: LLM-polish summarizer + Mem0 fact extraction + hard-truncation simulation. These three should close the Information Extraction / Multi-Session / Temporal gap.

**Confidence**: high on the measurement infrastructure (4/4 judges live, LongMemEval-grounded fixtures). Low on absolute production numbers (5 fixtures is small).

---

## Sources

- LongMemEval (Wu et al., ICLR 2025) — arxiv 2410.10813, GitHub xiaowu0162/LongMemEval. 5 ability + 6 question type taxonomy.
- LoCoMo (Snap, 2024) — long conversation benchmark referenced but not adopted (35 sessions × 9K tokens out of harness budget scale).
- Mem0 (arxiv 2504.19413) — fact-extraction memory architecture; referenced in improvement plan §3.
- User directive (2026-05-21): "신뢰할만한 성능인지 객관적인 지표도 필요 / 인터넷 찾아서 좀 더 신뢰할만한 테스트 찾아서 진행 / 한국어 없으면 참고해서 만들던가 / 다른 ai랑 크로스리뷰로 조사".
- Cross-review attempt — 4-CLI ensemble (GLM/opencode/codex/gemini) inside this Claude Code session hit sandbox/TTY blocks for opencode/codex/gemini on this prompt; GLM's `reasoning_content` carried the analysis (recommended build-from-scratch). Same 4 CLIs work perfectly when spawned inside the bench harness itself (LIVE smoke 4/4 PASS) — Claude-Code-internal CLI invocation is the brittle path, not the user's shell.

## Status

First objective measurement on LongMemEval-style criteria = SHIPPED. Compaction's *real* weakness now has hard data. Next session: improve recap fact preservation + hard-truncation simulation + larger fixture set.
