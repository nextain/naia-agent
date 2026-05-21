# CODE / TEST ADVERSARIAL AUDIT — R7 Phase B (Slice v2 / nextain/naia-agent#56)

## Audit mode (NOT verdict mode)

Read source. Run the harness in your head. Find broken / meaningless
measurement mechanics. Do NOT trace given flaw IDs — those framings are
banned (they caused R1-R5 to miss obvious patterns for 5 rounds).

## Background

- R1-R5 5 rounds of "adversarial review" were verdict-mode and missed
  major structural flaws (anthropic-native ≡ off; reactive-vercel no-op
  silently masked as off-equivalent; probes asking facts in preserved tail).
- R6 audit (gemini + glm convergent) verdict: **TRUST = NONE**. All R1-R5
  cells = artefacts.
- R7 Phase A rewrote the measurement infrastructure:
  - `anthropic-native` strategy REMOVED (was a sentinel `return undefined`)
  - `src/visible-context.ts` — single shared `buildVisibleContext()`
    used by both `runner.ts` and `mini-bench-judge.ts`
  - `classifyProbeStress()` + factTurns + validateFixture strict
  - `BENCH_CONFIG` shared (keepTail / contextCap / targetTokens)
  - reactive-vercel no-op detected explicitly (not silently fallback)
- R7 Phase B added factTurns + recap-only probes to all 6 fixtures.

## Files to read in full

Mandatory:
1. `packages/benchmarks/src/visible-context.ts` (NEW R7 A3)
2. `packages/benchmarks/src/fixture.ts` (R7 A4/A7 strict + classifyProbeStress)
3. `packages/benchmarks/src/runner.ts` (R7 A3 evaluateProbe via shared fn)
4. `packages/benchmarks/scripts/mini-bench-judge.ts` (R7 A1-A6 rewrite)
5. `packages/runtime/src/compaction/vercel-prepare-step.ts` (no-op guard)
6. All 6 fixtures: `packages/benchmarks/src/fixtures/F-*.fixture.json`
7. `packages/benchmarks/src/__tests__/harness-smoke.test.ts`

## Raw patterns to hunt — examples (not exhaustive)

1. **Sentinel returns / silent fallbacks still alive somewhere.**
   - `runner.ts` strategy branches.
   - `vercel-prepare-step.ts` (factory creating LLMMessagePrepareCompact —
     does it still silently swallow errors?).

2. **buildVisibleContext divergence**:
   - Are runner.ts evaluateProbe AND mini-bench-judge.ts actually calling
     the same `buildVisibleContext`? Verify file imports.
   - Any code path that bypasses the shared function?

3. **classifyProbeStress edge cases**:
   - factTurns with negative numbers? out-of-range? duplicates?
   - lastCompactionPoint === currentTurn (no tail)?
   - Probe at afterTurn === 0?
   - factTurns crossing the tail boundary (some in recap, some in tail)?
     What does it classify as? Is that the correct semantic?

4. **Fixture audit** — for each of the 6 fixtures, manually trace ONE
   probe through `buildVisibleContext` and confirm the visible string
   contains/excludes what you'd expect. Spot factual errors in the
   factTurns lists.

5. **N=1 statistical power still in effect.**
   - mini-bench-judge calls runEnsemble once per probe per strategy.
   - No re-runs, no confidence intervals.
   - One judge timeout still flips PASS↔FAIL.

6. **off baseline honesty**:
   - When strategy === "off", buildVisibleContext takes the
     "full transcript + cap" path. Verify the cap actually fires for
     all 6 fixtures (compute fixture total char count vs 1200 cap).

7. **reactive-vercel no-op signal flow**:
   - When pruneMessages returns undefined, factory returns undefined.
   - runner.ts: when prepare returns undefined, what's `recapContent`?
     (Should stay "" so vercelNoOp detection works.)
   - Trace one KR fixture and confirm `vercelNoOp` becomes true.

8. **Validate test coverage** — what does
   `__tests__/harness-smoke.test.ts` actually test? Does it verify
   the new `classifyProbeStress` outputs? Does it verify
   `buildVisibleContext`? Spot missing test coverage.

9. **memory.compact() return shape**:
   - When strategy is reactive / realtime, what does memorySystem.compact
     return? Is `result.summary.content` non-empty for our test
     LocalAdapter setup? (Without LLM, naia-memory may produce a
     deterministic recap or no recap at all.)
   - If recap is always "" or always identical, our reactive measurement
     is testing nothing.

## Hard questions (each must be answered with file:line citations)

A. **Does `mini-bench-judge.ts` import and use `buildVisibleContext` from
   `visible-context.ts`?** Show the import statement + the call site.

B. **Does `runner.ts:evaluateProbe` import and use `buildVisibleContext`?**
   Show import + call site.

C. **For F-KR-TR-01 (the cleanest recap-only fixture), trace one probe
   end-to-end: `validateFixture` → `runFixture` → `compact()` →
   `buildVisibleContext` → `evaluateProbe`. What is the actual visible
   string the LLM judge sees for strategy=reactive at probe@26?**

D. **For F-KR-AB-01 abstention probe (factTurns=[]), what does
   `classifyProbeStress` return? Is that the right semantic — abstention
   probes should be measured differently from regular recap/tail probes?**

E. **Pick the most likely scenario in which R7 numbers could STILL be
   artefacts despite Phase A+B fixes. Cite the code path.**

F. **Phase B added 6 recap-only probes across 6 fixtures (N=1 per fixture).
   For "strategy quality" measurement, is N=6 statistical power adequate?
   If not, what specific multi-probe addition would you require?**

## Deliverable

```
SECTION 1 — RAW FINDINGS
  Each finding: severity (HALT/MAJOR/MINOR), file:line, what code does,
  reproduction, why broken.

SECTION 2 — HARD QUESTIONS A-F (with citations)

SECTION 3 — TRUST VERDICT
  Compared to R6 audit's "TRUST = NONE":
  - Which Phase A+B fixes are actually trustworthy?
  - Which are still broken / new artefacts introduced?

SECTION 4 — NEXT REQUIRED WORK (Phase C and beyond)
  Ordered list. What MUST happen before any number is published.
```

Branch: `migration/slice-compact-v2`, HEAD = `f1fb9bf`.
Repo: `/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/`.
