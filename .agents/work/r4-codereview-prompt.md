# Adversarial Code-Review — Phase 1.3 R4 fixes

R3 verdict (gemini): **REGRESSED**. R4 (commit `d539e6e`) addresses:

- **S12 (CRITICAL)**: tail slice now starts at `lastCompactionPoint - keepTail` (was `lastCompactionPoint`). Closes the keepTail gap.
- **S18**: context-window cap applies uniformly to ALL strategies (was only off / anthropic-native / vercel-no-op).
- **S2 (systemic)**: F-EN-TH-01 fixture refactored — assistant turns with `[tool_use]` now followed by SEPARATE `role: tool` turn with `[tool_result]`. Matches real SDK message shape (assistant: text/tool_use/reasoning; tool: tool-result).

Code:

```ts
// extractVisibleContext (S12 fix)
const tailStart = Math.max(0, last - keepTail);
const tail = fixture.turns
  .slice(tailStart, currentTurn)
  .map((t) => `${t.role}: ${t.content}`)
  .join("\n");
```

```ts
// All strategies get the cap (S18 fix)
const CONTEXT_WINDOW_CHARS = 1200;
visible = simulateContextWindow(visible, CONTEXT_WINDOW_CHARS);
```

Fixture sample (S2 fix):
```json
{ "role": "assistant", "content": "[thinking] ...\n[tool_use book_hotel] {...}" },
{ "role": "tool", "content": "[tool_result] Booking confirmed. Confirmation #LCH-2026-05-23-A7Q3 ..." },
```

## Review questions

For each previous flaw: **REMAINS / FIXED / WORSE / NEW_FLAW**.

### S12 (Missing Middle)
1. With `tailStart = max(0, last - keepTail)`, what happens at probe
   `afterTurn` where `last === undefined` (no compaction yet)? The branch
   should return full transcript — verify it still does.
2. `keepTail=2` is hardcoded in the mini-bench call. The runner uses
   `keepTail` from RunOptions (also 2). Match achieved, but what if
   they diverge later? Should the harness read keepTail from runner
   results to stay in sync?

### S18 (uniform cap)
3. Now every strategy gets capped at 1200 chars. For `reactive`, the
   5-section markdown recap is typically ~500-800 chars + tail ~400-600
   chars → ~1000-1400 chars. Some recaps will be truncated. Is the
   right-aligned `simulateContextWindow` truncating from the WRONG end
   (the recap, not the older tail messages)?
4. For `off`, the LAST 1200 chars of the fixture are kept. For `reactive`,
   the LAST 1200 chars of recap+tail are kept (potentially throwing
   away the recap). Has the unfairness moved from one direction to
   another?

### S2 (fixture refactor)
5. `parseInlineBlocks` was designed assuming each line is a marker. The
   new fixture has assistant turns like:
   ```
   [thinking] ... long thinking
   on multiple lines
   [tool_use book_hotel] {...}
   ```
   gemini R3 flagged: multi-line `[thinking]` is split incorrectly. Has
   the new fixture's actual content been audited for multi-line thinking?
6. The new fixture has compactionPoints `[10]` and afterTurn `19`. Last
   compaction point is BEFORE the probe turn. With `tailStart = max(0,
   10-2) = 8`, tail covers turns 8..19. So even though we have a
   refactored fixture with proper tool messages, **the IDs the probe
   asks about are in the TAIL (turns 11, 12, 17, 18)** — they're in
   the verbatim assistant text after compaction. So **reactive-vercel
   may still pass trivially** because the SDK's prune doesn't touch
   post-compaction turns. Is this a fundamental measurement design flaw?
   To stress-test compaction, probes must ask about facts in the recap
   range (turns 0..7 in this fixture) that don't reappear in the tail.

### Re-verdict on R3-flagged unfixed
7. **S13** (runner vs mini-bench logic mismatch): does S18 unify them?
   Or does runner.ts's `evaluateProbe` still use a different cap (no
   cap at all)?
8. **S15** (trim destroys whitespace): unchanged. Real-world impact?
9. **S17** (over-truncation): unchanged. Worsened by uniform cap?

### NEW flaws (S19+)

Find them. Cite line numbers.

## Final verdict

**PUBLISHABLE / STILL_PRELIMINARY / WORSE_THAN_R3**.

Code paths:
- `packages/benchmarks/scripts/mini-bench-judge.ts` (extractVisibleContext, simulateContextWindow, uniform cap)
- `packages/benchmarks/src/runner.ts` (parseInlineBlocks, evaluateProbe)
- `packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json` (new shape)

Commits: R4 `d539e6e`, R3 `301fd65`, R2 `e5d4a94`, R1 `4b585df`.
