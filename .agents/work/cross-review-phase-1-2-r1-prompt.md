# Cross-Review Request — Slice 3-XR-Compact v2 / Phase 1.2 (#56) R1

You are reviewing a TypeScript change in `naia-agent` (4-repo Naia runtime,
ESM, Node ≥22, vitest).

## Intent

Wire the Vercel AI SDK `pruneMessages` cookbook helper (added in Phase 1.1,
commits 2a3ec01/55e88e5/54b49b1) into `Agent.sendStream`. The change is
opt-in via `--reactive-vercel` / `NAIA_AGENT_REACTIVE_VERCEL=1`. When
enabled AND `compactionStrategy === "reactive"`, the Agent replaces its
in-house `memory.compact()` path with the SDK's `pruneMessages` path.

**The "double-compaction guard" requirement**: exactly one compaction code
path runs per turn — never both the in-house `memory.compact()` AND the
Vercel `pruneMessages` path on the same turn.

## Architecture

- `packages/core` MUST NOT depend on the `ai` SDK (layering). So the hook
  is an injected callback `prepareCompact?: (history) => LLMMessage[] | undefined`.
- `packages/runtime` owns the `ai` SDK boundary — provides
  `createLLMMessagePrepareCompact(options)` factory + LLMMessage ↔
  ModelMessage adapters.
- `bin/naia-agent.ts` wires the factory when `--reactive-vercel`.

## Files changed (commit 4b585df)

```
bin/naia-agent.ts                                          | +21
packages/core/src/agent.ts                                 | +78
packages/runtime/src/__tests__/agent-vercel-compaction.test.ts | +210 (NEW)
packages/runtime/src/__tests__/llm-message-adapter.test.ts | +169 (NEW)
packages/runtime/src/__tests__/vercel-prepare-step.test.ts | +9 -7 (VPS-R2-05 fix)
packages/runtime/src/compaction/vercel-prepare-step.ts     | +208 -10
packages/runtime/src/index.ts                              | +3
```

## Full diff (most-relevant excerpts)

### packages/core/src/agent.ts — AgentOptions + #maybeCompact branch

```ts
export interface AgentOptions {
  // ...existing fields...
  /**
   * Optional history pre-processor — when provided AND
   * `compactionStrategy === "reactive"`, replaces the in-house
   * `memory.compact()` path with this callback. Receives the current
   * `LLMMessage[]` history (read-only); returns a pruned history or
   * `undefined` to skip.
   *
   * Double-compaction guard: when this hook is wired, the in-house
   * `memory.compact()` call is NOT issued for the reactive strategy.
   * Exactly one path runs per turn. Strategies `off`, `anthropic-native`,
   * and `realtime` ignore this option (semantics unchanged).
   */
  prepareCompact?: (
    history: readonly LLMMessage[],
  ) => LLMMessage[] | undefined;
}

// New private method inside Agent class:
async #runPrepareCompact(): Promise<AgentStreamEvent | undefined> {
  if (!this.#prepareCompact) return undefined;
  const before = this.#history.length;
  let pruned: LLMMessage[] | undefined;
  try {
    pruned = this.#prepareCompact(this.#history);
  } catch (err) {
    this.#host.logger.warn("agent.compaction.prepareCompact.error", {
      err: String(err),
    });
    return undefined;
  }
  if (!pruned || pruned.length === 0) return undefined;
  const dropped = Math.max(0, before - pruned.length);
  this.#history.splice(0, this.#history.length, ...pruned);
  this.#compactedThisSession = true;
  return { type: "compaction", droppedCount: dropped, realtime: false };
}

// Branch added inside #maybeCompact (after budget check):
if (this.#strategy === "reactive" && this.#prepareCompact) {
  return this.#runPrepareCompact();
}
// ...existing memory.compact() path follows...
```

### packages/runtime/src/compaction/vercel-prepare-step.ts — adapter + factory

```ts
// PruneMessagesOptions now derives from SDK directly (eliminates the stale
// R2 hand-rolled union that allowed "keep-all" / "remove-all" / "keep-last"
// — none of which are valid SDK literals).
export type PruneMessagesOptions = Omit<
  Parameters<typeof pruneMessages>[0],
  "messages"
>;

export function llmMessageToModelMessage(msg: LLMMessage): ModelMessage { ... }
export function modelMessageToLLMMessage(msg: ModelMessage): LLMMessage { ... }

export function createLLMMessagePrepareCompact(
  options: VercelCompactionOptions = {},
): (history: readonly LLMMessage[]) => LLMMessage[] | undefined {
  const inner = createVercelCompactionPrepareStep({
    compactAfterTokens: 0,
    ...options,
  });
  return (history) => {
    if (history.length === 0) return undefined;
    const modelMessages = history.map(llmMessageToModelMessage);
    const result = inner({ messages: modelMessages });
    if (!result) return undefined;
    const pruned = result.messages.map(modelMessageToLLMMessage);
    if (pruned.length === 0) return undefined;
    return pruned;
  };
}
```

### bin/naia-agent.ts — flag wiring

```ts
// New flag + env: --reactive-vercel / NAIA_AGENT_REACTIVE_VERCEL=1
// Applied at both Agent instantiations (direct mode, service mode):
const agent = new Agent({
  ...,
  compactionStrategy: args.compactStrategy,
  ...(args.reactiveVercel && args.compactStrategy === "reactive"
    ? { prepareCompact: createLLMMessagePrepareCompact() }
    : {}),
});
```

## Tests

- **10 new** adapter unit tests (`ADP-01..10`): round-trip text/reasoning/
  tool_use/tool_result blocks, lossy drops (redacted_thinking), threshold
  gates, pathological prune-to-empty rejection.
- **7 new** integration tests (`AVC-01..07`): double-compaction guard
  (memory.compact NOT called when prepareCompact wired + strategy=reactive),
  strategy gates (off/anthropic-native/under-budget), prepareCompact-throws
  safety.
- VPS-R2-05 updated (`toolCalls: "none"` instead of invalid `"keep-all"`).
- **465/465** runtime tests pass (was 448, +17 new).

## Pre-existing untouched issues

- `agent-compaction-strategy.test.ts` and `agent-handoff-loop.test.ts` have
  pre-existing tsc errors (text_delta chunk shape mismatch, Logger.trace
  not on Logger type) — vitest passes via type-erasure but `tsc --build`
  fails. Out of R1 scope.
- cli-app LIVE integration tests (40 failed) require GLM/ollama API keys
  absent in this harness — pre-existing, confirmed by HEAD stash sanity
  run.

## Review questions

Please give a **REQUEST_CHANGES / APPROVE / NEEDS_DISCUSSION** verdict and
specific actionable feedback. Focus on:

1. **Layering**: does `core` truly stay SDK-agnostic? Any leak through
   types or default values? The `prepareCompact` signature on
   `AgentOptions` uses only `LLMMessage` from `@nextain/agent-types`.

2. **Double-compaction guard correctness**: is it possible for BOTH paths
   to execute on the same turn under any code path? Consider:
   - Multiple compactions in a single turn (`compactedThisTurn` flag
     prevents this — verified)
   - `exportHandoff()` calls `memory.compact()` (handoff path is separate,
     not double-compaction — but reviewers should confirm the test correctly
     isolates this via `handoffThreshold: 0`)

3. **Adapter lossiness**: `redacted_thinking` is dropped (no SDK part),
   image data is preserved via FilePart. Are there any LLMContentBlock
   variants we're silently mishandling? `image` source `type === "url"`
   path?

4. **Threshold semantics**: factory defaults `compactAfterTokens: 0` so
   Agent's `contextBudget` is the single trigger. Is that the right
   design? Alternative: helper double-gates with its own threshold.

5. **Error swallowing**: `prepareCompact` throw is logged + ignored
   (turn survives, no fallback to in-house path). Is "no fallback" right,
   or should we fall back to `memory.compact()` on prepareCompact error?

6. **Surgical-changes check (karpathy 4원칙)**: anything in the diff that
   isn't directly traceable to "wire Vercel prune into Agent" intent?

Code conventions in this repo:
- TypeScript ESM only, Node ≥22, strict
- Conventional Commits
- karpathy 4원칙 (Think Before Coding / Simplicity / Surgical / Goal-Driven)
- F09: cleanroom-only dependency forbidden; SDK refs OK
- ref-* directories are read-only

Verdict and feedback please. Cite specific lines.
