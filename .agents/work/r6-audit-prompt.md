# CODE / TEST ADVERSARIAL AUDIT — Phase 1.3 (Slice v2 / nextain/naia-agent#56)

## What this prompt is

This is **NOT** a "verdict on previous findings" review. The previous
5 rounds (R1–R5) used verdict-mode prompts (REMAINS_BROKEN / NOW_FIXED
/ PUBLISHABLE), which framed reviewers into trace-the-given-flaw mode
and missed obvious patterns like **byte-identical result rows across
5 rounds**.

Your job here is **direct code / test audit**. You are not validating
anyone's claim. You are reading the source, running it in your head,
and finding broken / meaningless measurement mechanics.

## Primary task

**Read the following files in full and audit them.** Do not just skim
references — open and read.

1. `packages/benchmarks/src/runner.ts`
2. `packages/benchmarks/scripts/mini-bench-judge.ts`
3. `packages/benchmarks/src/fixture.ts`
4. `packages/benchmarks/src/fixtures/F-KR-IE-01-information-extraction.fixture.json`
5. `packages/benchmarks/src/fixtures/F-KR-MS-01-multi-session.fixture.json`
6. `packages/benchmarks/src/fixtures/F-KR-TR-01-temporal-reasoning.fixture.json`
7. `packages/benchmarks/src/fixtures/F-KR-KU-01-knowledge-update.fixture.json`
8. `packages/benchmarks/src/fixtures/F-KR-AB-01-abstention.fixture.json`
9. `packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json`
10. `packages/runtime/src/compaction/vercel-prepare-step.ts`
11. `packages/core/src/agent.ts` (sections around `#maybeCompact`, `#runPrepareCompact`)

## What to report — raw patterns, not flaw IDs

For each finding give:
- `file:line` exact citation
- **what the code actually does** (not what comments claim)
- **reproduction scenario** showing the resulting measurement artefact
- **severity**: HALT (measurement meaningless), MAJOR (results misleading), MINOR (cosmetic)

### Patterns to actively hunt — examples (not exhaustive)

1. **Two strategies / branches that share a code path** producing
   identical visible context — yet reported as separate result rows.
   (Hint: at R5, `anthropic-native` and `off` are byte-identical
   across all 5 rounds. Why? Read the code.)

2. **Sentinel / placeholder returns** (`return undefined`, `return ""`,
   `if (false)`, `throw new Error("TODO")`, no-op early-returns) in
   what the prompt claims are real strategy branches. If a strategy
   branch is a sentinel, its result row is fabricated.

3. **Probes that ask about facts which the strategy under test is not
   responsible for compressing.** If the asked fact lives in the
   preserved tail / a turn the strategy never touched, the probe does
   not stress that strategy.

4. **Visible-context construction that's structurally different
   between runner and mini-bench-judge.** R5 claims to align them —
   verify by reading both.

5. **fixture turns whose markers (`[thinking]` / `[tool_use]` /
   `[tool_result]`) are dropped or mis-routed** when converted to
   `LLMMessage` blocks — e.g. tool_result inside an assistant role
   message which the SDK adapter discards.

6. **fixture probe lists where N=1 per cell**, with no per-probe
   variance, and where one judge timeout flips PASS↔FAIL. Look at
   the actual probe counts in fixture JSON.

7. **Caps / truncation rules applied asymmetrically** — does the same
   1200-char cap actually fire identically for every strategy?
   Confirm by tracing one strategy run end-to-end.

8. **Test files claiming to verify the measurement** but mocking the
   thing they're supposed to verify (e.g. testing that
   `evaluateProbe` is called rather than testing its visible context
   output).

9. **Hard-coded values that should be config** — `keepTail=2`,
   `compactAfterTokens=0`, `1200`, `targetTokens=1000`. Where do they
   come from, who agrees, who's measuring what.

10. **Schema laxness** — `validateFixture` accepts almost anything;
    silent fallback for missing fields hides authoring bugs.

## Hard questions you must answer

After your audit, answer each in 1-3 sentences with `file:line`:

A. **Can `anthropic-native` and `off` actually produce different
   results in this harness as currently coded? If yes, in what
   scenario? If no, what is the `anthropic-native` row reporting?**

B. **Does `reactive-vercel` actually exercise Vercel's `pruneMessages`
   on a meaningfully different `ModelMessage[]` than what the
   Korean plain-text fixtures produce? Trace turn 5 (or any) of one
   KR fixture through `toLLMMessage` → `llmMessageToModelMessage` →
   `pruneMessages` and show what survives.**

C. **For F-EN-TH-01: do the asked probe facts (`LCH-2026-05-23-A7Q3`,
   `RES-J-A4K7`, Saturday weather) live in the recap window
   `turns[0..lastCompactionPoint]`, or in the preserved tail
   `turns[lastCompactionPoint-keepTail..currentTurn]`? Show the turn
   indices.**

D. **Is the 5-round result table (R1 → R5) reporting strategy
   quality, or measurement-harness artefacts? If artefacts, what
   single architectural fix would convert artefact-reporting into
   actual strategy-quality reporting?**

E. **`packages/benchmarks/src/runner.ts` line 612–624 has the
   `anthropic-native` early-return. Comment says "Server-side
   compaction is the authoritative path". Does any code in this
   repo actually call Anthropic's server-side compaction (beta
   header `compact-2026-01-12`)? Cite the file or confirm it
   does not exist.**

F. **Look at all 6 fixture JSON files. Count the `task-accuracy`
   probes per fixture and report. Then look at `mini-bench-judge.ts`
   to see how many of those it actually evaluates per strategy
   per fixture. Report N per cell.**

## Final deliverable

```
SECTION 1 — RAW FINDINGS (10-20 items)
  Finding #N
  Severity: HALT | MAJOR | MINOR
  Location: file:line
  What code does (1-2 sentences):
  Reproduction: <scenario>
  Why it makes the measurement broken:

SECTION 2 — HARD QUESTIONS A–F (each answered in 1-3 sentences with citations)

SECTION 3 — TRUST VERDICT
  Of the 5-round result tables we've produced, which rows / cells
  are reporting:
    (a) actual strategy differences  (TRUST)
    (b) measurement artefacts        (DISTRUST)
    (c) cannot determine              (UNKNOWN)
  Be specific. Cite cells.

SECTION 4 — IF YOU WERE THE BENCHMARK AUTHOR
  In 5-10 bullets, what would you tear down and rebuild before
  publishing any number?
```

## Bias warning to you, the reviewer

The previous 5 rounds praised `reactive-vercel` because the harness
fed the asked-fact directly into the visible context regardless of
what `pruneMessages` did. Read the actual `extractVisibleContext` and
`evaluateProbe` code and check whether the `reactive-vercel` row
ever measured the prune itself or just measured "did
`llmMessagesToText` happen to retain assistant text containing the
ID."

You are encouraged to conclude that **most of the 5-round table is
artefacts**. We will not push back. We want the audit truth.

---

Working dir: `/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/`
Branch: `migration/slice-compact-v2`, HEAD = `9a1352a`.
