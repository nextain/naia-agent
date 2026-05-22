# ADVERSARIAL REVIEW — Phase 1.3 R3 measurement numbers

R1 verdict (3/3 valid AI): **UNPUBLISHABLE, 10 flaws**.
R2 verdict (gemini codereview): **S1/S5/S8 FIXED, S2/S9/S10/S11/S12/S13/S14 still broken**.
R3 codereview (this is the next-step parallel): TBD.

R3 fixes applied (commit `0d976e7`):
- **S2 proper**: `parseInlineBlocks` converts inline `[thinking]`/`[tool_use]`/`[tool_result]` markers to real LLMContentBlock parts so pruneMessages sees structured input.
- **S14**: restore tail for reactive-vercel.
- **S11**: vercel no-op also gets context-window truncation.
- **S10 stronger**: cap 2000 → 1200 chars.

**This prompt actually carries the R5 results (R3-R5 rounds since the
template was written; rounds were cumulative).**

R5 measurement (6 fixtures × 5 strategies × 1-2 probes × 4 judges):

| Strategy | R1 | R2 | R3 | R4 | R5 |
|---|---:|---:|---:|---:|---:|
| reactive | 0.40 | 0.83 | 0.83 | 0.75 | 0.75 |
| reactive-vercel | 0.40 | 0.50 | 1.00 | 0.75 | **0.92** |
| realtime | 0.40 | 0.67 | 0.83 | 0.58 | 0.75 |
| anthropic-native | 1.00 | 1.00 | 0.67 | 0.67 | 0.67 |
| off | 1.00 | 1.00 | 0.67 | 0.67 | 0.67 |

R5 fixes since R4 (all from gemini's R4 WORSE_THAN_R3 review):
- S13: runner.ts evaluateProbe aligned with mini-bench (same tail
  logic + same 1200-char cap).
- S2 fundamental: new task-accuracy probe in F-EN-TH-01 asks about
  Saturday weather (recap range, NOT tail) — forces recap-dependent
  recall.
- S18 fairness inversion: cap preserves recap whole, truncates tail
  only for compacted strategies.
- S19: simulateContextWindow seeks role-prefixed line starts (not
  arbitrary newline).
- S15: parseInlineBlocks no longer trims.
- S20: module-level tool-call counter (links [tool_use] /
  [tool_result] across the assistant+tool turn pairs).

Per-fixture R5 detail:

| Fixture | reactive | reactive-vercel | realtime | anthropic-native | off |
|---|---:|---:|---:|---:|---:|
| F-KR-IE | 1.000 | 1.000 | 1.000 | 0.000 | 0.000 |
| F-KR-MS | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| F-KR-TR | 0.000 | 1.000 | 0.000 | 1.000 | 1.000 |
| F-KR-KU | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| F-KR-AB | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| F-EN-TH | 0.500 | 0.500 | 0.500 | 0.000 | 0.000 |

## Your adversarial task

You found 10 real flaws across R1 + R2. R3 attempts to honestly fix the
most damaging ones. Re-attack:

For each previously-real flaw (S1/S2/S5/S8/S9/S10/S11/S12/S13/S14):
**REMAINS_BROKEN / NOW_FIXED / WORSE / IRRELEVANT_AFTER_OTHER_FIX**.

Then **find new flaws (S15+)** that R3 introduced. Specifically:
- Did the 1200-char cap make `off` artificially worse than reality?
- Did `parseInlineBlocks` correctly expose `[tool_result]` content to
  the SDK, or is it dropped at the `llmBlockToAssistantPart` boundary?
- Did the `extractVisibleContext` distinct branches for `reactive` vs
  `reactive-vercel` smuggle in a new unfair asymmetry?
- N=1 cells still — flagged S3 from R1 is open. Is this round any more
  trustworthy than R1, even if individual flaws are patched?

Final verdict: **PUBLISHABLE / STILL_PRELIMINARY / WORSE_THAN_R2**.

If PUBLISHABLE: in what venue? (paper / blog / internal slide).
If STILL_PRELIMINARY: what are the *minimum* additional fixes before
numbers are citable, ranked by severity.

Code paths:
- `packages/benchmarks/src/runner.ts`
- `packages/benchmarks/scripts/mini-bench-judge.ts`
- `packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json`
- `packages/benchmarks/src/fixtures/F-KR-*.fixture.json`
- `packages/runtime/src/compaction/vercel-prepare-step.ts`

Commits: R1 `4b585df`, R2 `9c82688`, R3 fixes `0d976e7`, R2 measurement
`e5d4a94`. Branch `migration/slice-compact-v2`.
