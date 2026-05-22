# Adversarial Code-Review — Phase 1.3 R3 fixes (independent of R3 numbers)

R2 code-review (gemini, 2026-05-21T05-33-45) found:
- **S1/S8/S5 FIXED**
- **S2 DOESNT_FIX_R1** (fixture markers were string-in-content, not SDK blocks)
- **S9 NEW_BUG** (R2 removed legitimate tail data)
- **S10 PARTIAL** (2000-char cap too lenient)
- **S11/S12/S13/S14** new flaws

R3 commit `0d976e7` addresses S2/S10/S11/S14. Your job:
- Verify each R3 fix actually solves what it claims
- Find NEW bugs introduced
- Re-verdict S12/S13 (R3 didn't touch them — are they still real?)

## R3 fixes

### S2 (proper) — `runner.ts toLLMMessage()` + `parseInlineBlocks()`

```ts
function parseInlineBlocks(content: string): LLMContentBlock[] | null {
  if (!content.includes("[thinking]") && !content.includes("[tool_use ")
      && !content.includes("[tool_result]")) return null;
  const blocks: LLMContentBlock[] = [];
  const lines = content.split("\n");
  let textBuf: string[] = [];
  const flushText = (): void => {
    if (textBuf.length > 0) {
      const text = textBuf.join("\n").trim();
      if (text.length > 0) blocks.push({ type: "text", text });
      textBuf = [];
    }
  };
  let toolCallCounter = 0;
  for (const line of lines) {
    const thinkMatch = /^\[thinking\]\s*(.*)$/.exec(line);
    if (thinkMatch) {
      flushText();
      blocks.push({ type: "thinking", thinking: thinkMatch[1] ?? "" });
      continue;
    }
    const toolUseMatch = /^\[tool_use\s+([\w_\-]+)\]\s*(.*)$/.exec(line);
    if (toolUseMatch) {
      flushText();
      let input: unknown = {};
      try { input = JSON.parse(toolUseMatch[2] ?? "{}"); }
      catch { input = { raw: toolUseMatch[2] }; }
      toolCallCounter++;
      blocks.push({
        type: "tool_use", id: `call_${toolCallCounter}`,
        name: toolUseMatch[1] ?? "", input,
      });
      continue;
    }
    const toolResultMatch = /^\[tool_result\]\s*(.*)$/.exec(line);
    if (toolResultMatch) {
      flushText();
      const callId = `call_${toolCallCounter || 1}`;
      blocks.push({
        type: "tool_result", toolCallId: callId,
        content: toolResultMatch[1] ?? "",
      });
      continue;
    }
    textBuf.push(line);
  }
  flushText();
  return blocks.length > 0 ? blocks : null;
}

function toLLMMessage(turn: FixtureTurn): LLMMessage {
  const role = mapRole(turn.role);
  const blocks = parseInlineBlocks(turn.content);
  if (blocks === null) return { role, content: turn.content };
  return { role, content: blocks };
}
```

### S14 — `extractVisibleContext()` reactive-vercel tail restore

```ts
if (strategy === "reactive-vercel" && last !== undefined && recapContent.length > 0) {
  const tail = fixture.turns
    .slice(last, currentTurn)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");
  return `[reactive-vercel post-prune window]\n${recapContent}\n\n${tail}`;
}
```

### S11 — context-window also applies to vercel no-op fallback

```ts
const CONTEXT_WINDOW_CHARS = 1200;
const needsTruncation =
  strategy === "off" ||
  strategy === "anthropic-native" ||
  (strategy === "reactive-vercel" && (fr.recapContent ?? "").length === 0);
if (needsTruncation) {
  visible = simulateContextWindow(visible, CONTEXT_WINDOW_CHARS);
}
```

### S10 stronger — 1200-char cap (was 2000)

Comment in code: "1200 chars ≈ 300 tokens — tighter than R2's 2000 to honestly represent that a real provider would force-truncate the head of a ~30-turn Korean transcript long before the agent's budget hook fired."

## R3 review questions

For each: **FIXED / PARTIAL / NEW_BUG / DOESNT_FIX**.

### S2 proper fix
1. `parseInlineBlocks` handles inline markers in fixture content. But:
   - Assistant turns in `F-EN-TH-01` contain BOTH `[tool_use]` AND
     `[tool_result]` markers in the same turn. After parsing, the
     LLMMessage will have role=assistant with content blocks including
     `tool_result` — but `llmBlockToAssistantPart` in
     `vercel-prepare-step.ts` drops tool_result blocks (no SDK assistant
     part for tool-result; only the `tool` role's content carries them).
     So the IDs in `[tool_result]` content are silently lost. **Did we
     actually expose them to pruneMessages?** Trace through and verify.
   - `[tool_use ...] {non-JSON}` falls back to `input = { raw: ... }`.
     Is that correct for the SDK's `tool-call` part schema (it expects
     parameters to be a JSON-serializable object)?
   - Multi-line `[thinking]` content: the regex consumes only the same
     line. Multi-line thinking would be split. Is that a real-world
     fixture concern?

### S14 restore-tail fix
2. After R3, what happens at probe `afterTurn` that is exactly equal to
   `lastCompactionPoint`? `slice(last, currentTurn)` = `slice(N, N)` = []
   = empty tail. So visible = recap + "\n\n" + "" = recap with trailing
   blank line. Cosmetic only, or does it leak signal to judges?

### S11 + S10 stronger
3. 1200 chars ≈ 300 tokens. The five KR fixtures have ~30 turns averaging
   ~80–120 chars each = ~3000 chars total. Truncating to 1200 keeps the
   last ~10–13 turns. Probe questions are answered from those last
   turns OR from earlier facts that compaction was supposed to preserve.
   For `off`, the LATER turns survive but EARLIER facts (e.g. F-KR-IE's
   "walnuts/cashews" mentioned around turn 3) are gone.
   - Is this the right "production cap" intuition? Or is 1200 chars an
     artificially small bound that's now biased the OTHER way (off too
     handicapped)?
4. The cap is applied UNIFORMLY at 1200 chars regardless of fixture
   length. Is fixture-relative (e.g. `min(1200, totalChars * 0.4)`)
   more honest?

### Re-verdict on R2-flagged but R3-untouched
5. **S12** (gemini): "runner.ts driftScore at line 391 double-tails when
   reactive-vercel (recap already contains tail, slice(-keepTail) on
   top)". Re-read `runner.ts:393-402`. Is this STILL a real bug? My
   reading: the recap for `reactive-vercel` IS the full pruned history
   serialized — so appending `fixture.turns.slice(-keepTail)` does
   double-count. **Verify.**
6. **S13**: "deterministic vs ensemble context-window logic mismatch".
   Did R3's S11+S10 changes accidentally fix this, or make it worse?
   `evaluateProbe` (runner.ts) builds visible context based on
   `lastCompactionPoint + keepTail`; `mini-bench-judge.ts` builds
   visible context based on `last + simulateContextWindow`. Are the
   two views now even further apart?

### NEW flaws (S15+)

Find them. Specific file/line. Attack scenarios.

## Final verdict

**ALL_FIXED / PARTIALLY_BETTER / NO_PROGRESS / REGRESSED**.

If `PARTIALLY_BETTER`: list the unresolved/new issues that block
publishability.

Code paths:
- `packages/benchmarks/src/runner.ts` (parseInlineBlocks, toLLMMessage, driftScore)
- `packages/benchmarks/scripts/mini-bench-judge.ts` (extractVisibleContext, simulateContextWindow, needsTruncation)
- `packages/runtime/src/compaction/vercel-prepare-step.ts` (no-op guard)
- `packages/benchmarks/src/fixtures/F-EN-TH-01-tool-heavy.fixture.json`

Commit: `0d976e7`. R2 commit: `9c82688`. R1 commit: `4b585df`.
Branch: `migration/slice-compact-v2`.
