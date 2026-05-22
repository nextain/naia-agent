# Cross-Review — Phase 1.3 R2 CODE fixes (independent of R2 measurement numbers)

You are reviewing the code-level fixes (commit `9c82688`) that address the
R1 adversarial findings (commit `4b585df` measurement → review report
`packages/benchmarks/reports/cross-review-2026-05-21T05-17-15.md`).

The R2 fixes are listed below. **R2 measurement numbers are NOT yet in
your scope** — they are running in background. Your job is to check
whether the code changes actually solve what they claim to solve.

## Fixes in scope

| # | R1 finding | R2 file change |
|---|---|---|
| S1 | `extractVisibleContext()` ignored real recap | `FixtureResult.recapContent` exposed; harness consumes it |
| S8 | probe used reverse-engineered question | Schema: `task-accuracy.question?: string` + 5 KR fixtures backfilled + fallback stderr warning |
| S9 | `reactive-vercel` got double-tail | Distinct branch — pruned history as-is, no synthetic tail |
| S10 | `off` / `anthropic-native` = oracle | `simulateContextWindow(visible, 2000)` right-aligned truncation |
| S5 | "Deterministic task" misleading | Renamed `Anchor-heuristic` |
| S2 | All fixtures plain-text → Vercel no-op | New `F-EN-TH-01-tool-heavy.fixture.json` with `[thinking]`/`[tool_use]`/`[tool_result]` |

## Key diff hunks (commit 9c82688)

### S1 — FixtureResult.recapContent

`packages/benchmarks/src/fixture.ts`:
```ts
export interface FixtureResult {
  // ...
  readonly errors: readonly string[];
  readonly recapContent?: string;
}
```

`packages/benchmarks/src/runner.ts`:
```ts
return {
  // ...
  errors,
  recapContent,
};
```

### S8 — explicit question

`fixture.ts`:
```ts
| {
    readonly afterTurn: number;
    readonly type: "task-accuracy";
    readonly criterion: string;
    readonly question?: string;
  }
```

`mini-bench-judge.ts`:
```ts
const explicitQuestion =
  probe.type === "task-accuracy" ? probe.question : undefined;
const fallbackQuestion =
  fixture.turns.slice(0, probe.afterTurn)
    .filter((t) => t.role === "user").pop()?.content ?? "(unknown)";
if (!explicitQuestion) {
  process.stderr.write(`  ⚠ S8 fallback: ...\n`);
}
const lastUserTurn = explicitQuestion ?? fallbackQuestion;
```

### S9 — reactive-vercel visible context

`mini-bench-judge.ts`:
```ts
if (strategy === "reactive-vercel" && last !== undefined && recapContent.length > 0) {
  return `[reactive-vercel post-prune window]\n${recapContent}`;
}
if (isCompactStrategy && last !== undefined && recapContent.length > 0) {
  const tail = fixture.turns.slice(last, currentTurn).map(...).join("\n");
  return `[after compaction at turn ${last}]\n${recapContent}\n\n${tail}`;
}
```

### S10 — simulateContextWindow

```ts
function simulateContextWindow(text: string, windowChars: number): string {
  if (text.length <= windowChars) return text;
  const tailStart = text.length - windowChars;
  const nlAfterCut = text.indexOf("\n", tailStart);
  const start = nlAfterCut !== -1 ? nlAfterCut + 1 : tailStart;
  return `[context truncated by provider — ${(text.length - start)} of ${text.length} chars retained]\n${text.slice(start)}`;
}

// in main():
if (strategy === "off" || strategy === "anthropic-native") {
  visible = simulateContextWindow(visible, 2000);
}
```

### S5 — column rename

```ts
"| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |",
```

### S2 — new fixture

`packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json` —
14 turns including:
```json
{ "role": "assistant", "content": "[thinking] The user wants ...\n[tool_use weather_lookup] {...}\n[tool_result] Saturday: sunny..." }
```

3 probes: 1 task-accuracy ("Summarize the user's complete weekend Busan trip plan..."), 2 fact-recall for booking confirmation numbers.

## Review questions

For each fix, give one of: **FIXED / PARTIAL / NEW_BUG / DOESNT_FIX_R1**.

1. **S1 fix**: Does exposing `recapContent` actually fix the unfairness?
   What happens when `recapContent === ""` (no compaction or no-op
   prune) and `last !== undefined`? Could the fallback branch leak the
   old unfair behaviour?

2. **S8 fix**: stderr warning is logged but doesn't block. Should it be
   an error? Are there fixtures where the implicit fallback question is
   semantically correct (so a warning would be noise)?

3. **S9 fix**: For `reactive-vercel`, the visible context is the
   `recapContent` (which `runner.ts` built from `llmMessagesToText()`
   on pruned messages). But pruning was a no-op (returned `undefined`)
   in the cookbook-default case — does `recapContent` then stay `""`?
   If so, what visible context does S9's branch produce?
   (Trace: `runner.ts:282` — when prepare returns undefined, recap
   doesn't change. Initial value is `""`.)

4. **S10 fix**: `simulateContextWindow(visible, 2000)` is right-aligned.
   2000 chars ≈ 500 tokens. Is this the right cap for representing a
   production budget? Korean fixtures have 28–32 turns — what fraction
   of the transcript fits in 2000 chars? Could 2000 still be oracle for
   short fixtures?

5. **S5 rename**: "Anchor-heuristic" is more honest, but the heuristic
   itself (length > 200 AND domain anchor present) is still in
   `evaluateProbe()` and still reports a number. Is the rename enough
   or should the column be removed entirely from the headline?

6. **S2 fixture**: Does `F-EN-TH-01-tool-heavy` realistically exercise
   the Vercel cookbook prune recipe? The `[thinking]` / `[tool_use]` /
   `[tool_result]` blocks are encoded as **STRING markers inside content**,
   not as Vercel SDK message parts. Does the prune actually see them as
   reasoning blocks for the `reasoning: "all"` rule, or are they just
   text-in-content (treated as opaque by pruneMessages)?
   (Check: `runner.ts:439-450` — `llmMessagesToText` serializes naia
   blocks to text. But the input to pruneMessages is a `ModelMessage[]`
   constructed by `runner.ts:331-335` via `toLLMMessage()` which sets
   `content` to the **raw string** — no thinking-block adaptation. So
   `[thinking]` markers are inside `content: string`, not `content:
   [{ type: "reasoning", text: "..." }]`. Verify whether this means
   the new fixture actually doesn't trigger the prune rules.)

## Verdict format

```
S1: FIXED | PARTIAL | NEW_BUG | DOESNT_FIX_R1
  Verdict reason: <one paragraph>
  Concrete attack scenario (if not FIXED): <one paragraph>

S2: ...
...

NEW_FLAWS_FOUND_IN_R2_CODE (S11+): ...
```

Code paths to inspect:
- `packages/benchmarks/scripts/mini-bench-judge.ts`
- `packages/benchmarks/src/runner.ts` (especially `toLLMMessage` + `llmMessagesToText` + the reactive-vercel branch)
- `packages/benchmarks/src/fixture.ts`
- `packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json`
- `packages/runtime/src/compaction/vercel-prepare-step.ts` (no-op gate)

Commit: `9c82688`. Branch: `migration/slice-compact-v2`.
