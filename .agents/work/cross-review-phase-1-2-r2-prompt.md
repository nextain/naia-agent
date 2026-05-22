# Cross-Review Request — Slice 3-XR-Compact v2 / Phase 1.2 (#56) R2

You previously reviewed R1 (commit `4b585df`). R2 addresses the codex
REQUEST_CHANGES findings (3 issues). Please re-verdict.

## R1 verdict recap

- opencode: APPROVE
- gemini: APPROVE
- glm: APPROVE
- codex: **REQUEST_CHANGES** (3 issues)

## R2 fixes (commit `60dc9e7`)

### codex #1 (P0) — No-op prune accepted as success

`createLLMMessagePrepareCompact` now rejects no-op results. After running
`pruneMessages`, it computes total content-char counts before/after and
returns `undefined` if neither message-count nor char-count shrunk:

```ts
const beforeChars = countContentChars(history);
const afterChars = countContentChars(pruned);
if (pruned.length >= history.length && afterChars >= beforeChars) {
  return undefined;  // no-op — reject so Agent doesn't treat as success
}
return pruned;
```

`countContentChars` walks each LLMMessage content block:
- string → length
- text/thinking/redacted_thinking/tool_result → text length
- tool_use → JSON.stringify(input).length
- image → source.data.length

### codex #2 (P0) — URL-backed images mislabeled as base64

`llmBlockToUserPart` now branches on `source.type`:

```ts
if (block.source.type === "url") {
  return {
    type: "file" as const,
    data: new URL(block.source.data),
    mediaType: block.source.mediaType,
  };
}
// base64 path unchanged
return { type: "file" as const, data: block.source.data, ... };
```

`modelMessageToLLMMessage` reverse:

```ts
} else if (p.type === "file") {
  if (p.data instanceof URL) {
    blocks.push({ type: "image", source: { type: "url", ... }});
  } else if (typeof p.data === "string") {
    blocks.push({ type: "image", source: { type: "base64", ... }});
  }
}
```

### codex #3 (P1) — tool_result.isError dropped

`llmMessageToModelMessage` tool-role emits `error-text` for failed results
(matches `packages/providers/src/vercel-client.ts:347-351` pattern):

```ts
output: b.isError
  ? { type: "error-text" as const, value: b.content }
  : { type: "text" as const, value: b.content },
```

Reverse adapter detects `error-text` and restores `isError: true`:

```ts
const isError =
  p.output && typeof p.output === "object" && "type" in p.output &&
  p.output.type === "error-text";
content.push({
  type: "tool_result",
  toolCallId: p.toolCallId,
  content: outputValue,
  ...(isError ? { isError: true } : {}),
});
```

## Tests added/changed

- **ADP-08** reframed: history with `thinking` block, asserts thinking
  is stripped after default cookbook prune (proves R2 still shrinks the
  cases where shrinking is possible).
- **ADP-08b NEW**: no-op prune on plain text → returns `undefined`
  (regression guard for codex #1).
- **ADP-09b NEW**: URL image round-trip preserves `source.type: "url"`.
- **ADP-09c/d NEW**: tool_result.isError preserved (true / undefined paths).
- **AVC-03** rewritten: deterministic always-shrinks prepareCompact mock
  so emission-count assertion doesn't depend on pruneMessages's text-only
  no-op behaviour. Also asserts `memory.captured.length === 0` (double-
  compaction guard still holds).
- **AVC-08 NEW**: end-to-end no-op rejection. Plain-text history →
  prepareCompact returns undefined → **NO** `compaction` event AND **NO**
  fallback to `memory.compact()`. Exactly-one-path contract holds even
  on no-op.

**Result: 37/37 phase-1.2 tests pass + 470/471 runtime total** (was 465 at
R1, +5 new tests, +1 regression-trapped re-frame).

## Review questions (R2)

1. **codex #1 fix**: does the char-count + length comparison correctly
   detect no-op? Edge case — what if pruning REPLACES content with
   different but equal-length text (`pruneMessages` doesn't do this, but
   defensively)? Is `>=` comparison the right boundary?

2. **codex #2 fix**: SDK FilePart accepts `DataContent | URL`. Is the
   `new URL(...)` pattern + `instanceof URL` check correct? Any
   serialization gotchas if the URL string is malformed at input time?

3. **codex #3 fix**: tool_result with both empty content AND isError=true
   currently emits `{ type: "error-text", value: "" }`. Round-trip
   restores `isError: true` and `content: ""`. Is that the desired
   behaviour, or should empty-error be normalized?

4. **Defense in depth**: is the no-op gate sufficient, or should we also
   check that the post-prune estimate (via injected estimator) is lower
   than the budget? Currently we only check char-shrinkage.

5. **Any new layering concerns** introduced by R2 (everything stays in
   runtime; core untouched in R2).

Please give a **REQUEST_CHANGES / APPROVE / NEEDS_DISCUSSION** verdict.
Conventions reminder: TypeScript ESM strict, F09 cleanroom-only-dep
forbidden, karpathy 4원칙 (surgical changes only).

Commits: R1 `4b585df`, R2 `60dc9e7`. Branch: `migration/slice-compact-v2`.
