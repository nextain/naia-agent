# ADVERSARIAL REVIEW — Slice 3-XR-Compact v2 / Phase 1.3 (#56) R2 measurement

You previously found **10 real flaws** in R1 (verdict UNPUBLISHABLE,
3/3 valid AI agreement). R2 (commit `9c82688`) addresses the P0/P1
findings. Your job now: **break the R2 measurement** harder than R1.
Don't grade on a curve — same hostility.

## R2 fixes applied

| # | R1 finding | R2 fix | File |
|---|---|---|---|
| **S1** | `extractVisibleContext()` ignored real recap | `FixtureResult.recapContent` exposed; harness consumes it | `runner.ts`, `mini-bench-judge.ts` |
| **S8** | probe used reverse-engineered question | Probe schema gained `question?: string`; 5 KR fixtures backfilled; fallback emits stderr warning | `fixture.ts`, `mini-bench-judge.ts`, `F-KR-*.fixture.json` |
| **S9** | `reactive-vercel` got double-tail (recap = full pruned history + extra fixture tail) | Distinct branch for `reactive-vercel`: show pruned history as-is, no synthetic tail | `mini-bench-judge.ts` |
| **S10** | `off` / `anthropic-native` got full transcript = oracle | `simulateContextWindow(text, 2000)` right-aligned truncation | `mini-bench-judge.ts` |
| **S5** | "Deterministic task" column was misleading construct mismatch | Renamed `Anchor-heuristic` + JSDoc note | `mini-bench-judge.ts` |
| **S2** | All fixtures plain-text → Vercel always no-op | Added `F-EN-TH-01-tool-heavy` with explicit `[thinking]`/`[tool_use]`/`[tool_result]` blocks | new fixture |

## R2 results (6 fixtures × 5 strategies × 1 probe × 4 judges)

[INSERT R2 RESULTS TABLE — same shape as R1]

## Deferred (open for you to validate they're still deferred, NOT now-broken)

- **S3** (N=1 per cell, no CIs) — still deferred. Single-shot judge calls per cell.
- **S4** (no real LongMemEval-S baseline comparison) — banner removed from headlines.
- **S6** (priorRecap asymmetry) — labeled intentional (different strategy classes).
- **S7** (denominator-shrink on judge infra-error) — denominator math unchanged.

## Your task

For each of S1/S2/S5/S8/S9/S10:
- Is the R2 fix actually correct, or did we introduce a new bug?
- Did the fix change verdicts (vs R1) in a way that's defensible, or
  did it just move the artifact around?
- Verdict: **FIXED / PARTIAL / BROKEN_DIFFERENTLY / STILL_BROKEN**

For S3/S4/S6/S7:
- Are these still acceptably deferred for this round? Or did R2 changes
  silently re-open them?

Then **find new flaws (S11+)** that R2 introduced or that R1 missed.
Be specific — file paths, line numbers, attack scenarios.

End with: **PUBLISHABLE / STILL_PRELIMINARY / WORSE_THAN_R1**.

If `PUBLISHABLE`: would you cite these numbers in a paper? In a blog
post? In an internal slide? Be precise about the audience.

Code paths:
- `packages/benchmarks/scripts/mini-bench-judge.ts`
- `packages/benchmarks/src/runner.ts`
- `packages/benchmarks/src/fixture.ts`
- `packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json`
- `packages/benchmarks/src/fixtures/F-KR-*.fixture.json`
- `packages/runtime/src/compaction/vercel-prepare-step.ts`

Commits: R1 measurement `4b585df`, R2 fixes `9c82688`.
Branch: `migration/slice-compact-v2`.
