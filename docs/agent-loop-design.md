# Agent Loop Design — references and decisions

Design doc for `packages/core/src/agent.ts` (Phase 2 X3 scaffold).
Captures why each choice was made, with reference to source material.

## References surveyed

| Source | Location | Strength | Weakness |
|---|---|---|---|
| **careti** (via naia-os/agent) | `naia-os/agent/src/index.ts` | Battle-tested streaming, `MAX_TOOL_ITERATIONS` loop, tool partitioning (concurrent vs sequential), tier-based approval via `pendingApprovals` Map, token budget pre-flight (warn-only), MCP cleanup | Budget check warns but does not compact — compaction TODO'd to #185 Phase 2 |
| **opencode session/compaction** | `refs/ref-opencode/packages/opencode/src/session/{session,compaction,processor}.ts` | Formal compaction policy: `PRUNE_MINIMUM`, `PRUNE_PROTECT`, `preserveRecent`, turn-unit granularity. DB-backed persistence. | Effect + SQL makes it heavy for an embeddable runtime library. Overkill for our zero-runtime-dep + DI-first posture. |
| **claude-code** (analysis) | `.agents/progress/11-ref-cc-analysis.json` + naia-os README quote | Automatic compaction, `CLAUDE.md`-based memory layer with subagent spawning | Memory is file-system and single-directional — no bidirectional real-time memory update |
| **alpha-memory** | `projects/alpha-memory/src/memory/index.ts` | 4-store architecture, background consolidation (30-min default), reconsolidation (contradiction detection), Ebbinghaus decay, `consolidateNow(force)` for manual trigger | Current `consolidate()` is background; real-time stream compaction is a future capability (discussed separately) |

## Decisions

### D1. Stream-first API, `send()` as drain wrapper

```
Agent.sendStream(userText, signal?): AsyncGenerator<AgentStreamEvent>
Agent.send(userText, signal?): Promise<string>  // drains sendStream
```

**Why**: streaming is the only shape compatible with alpha-memory's
planned real-time compaction (it wants to observe generation as it
happens). `send()` as a convenience wrapper keeps the simple case simple.

Ref: careti (stream-based) > opencode (also stream, via Effect).

### D2. Compaction delegated to MemoryProvider via `CompactableCapable`

```ts
// @nextain/agent-types/memory.ts
export interface CompactableCapable {
  compact(input: CompactionInput): Promise<CompactionResult>;
}
```

**Why**:
- **Alpha-memory integration target** — memory already owns consolidation; compaction is a natural extension.
- **Real-time future** — alpha-memory can evolve `compact()` from on-demand to pre-computed (maintain rolling summary during `encode()` calls). Agent code does not change.
- **Graceful degradation** — if `memory` does not implement the capability, Agent falls back to simple sliding-window truncation (keep tail N, drop head).

Ref: opencode formalized compaction but tied it to its own DB; we abstract
to a capability interface so any memory can plug in.

### D3. Compaction policy constants (agent-side)

| Param | Default | Why |
|---|---:|---|
| `contextBudget` | 80_000 tokens | Safe for most 128K+ context models |
| `compactionKeepTail` | 6 messages | ~3 turns; matches opencode `DEFAULT_TAIL_TURNS = 2` (bit more generous) |
| `estimateTokens` | chars/4 heuristic | Host injects provider-accurate tokenizer when available |

Triggered before every LLM call (inside the tool-hop loop), so long
tool-use chains eventually compact themselves instead of exploding.

### D4. Tool-hop loop bounded by `maxToolHops` (default 10)

**Why**: matches careti's `MAX_TOOL_ITERATIONS = 10`. Prevents
runaway loops, surfaces the condition via `turn.ended` with stub text
`[agent stopped — reached max tool-hop budget]`. Logger emits warning.

### D5. Tool execution delegated via `HostContext.tools` + `tierForTool` resolver

Agent does not implement approval, tier policy, or actual execution. It
constructs a `ToolInvocation` with tier from the caller-provided resolver
and delegates to `HostContext.tools.execute()`. Wrap with
`GatedToolExecutor` (from `@nextain/agent-runtime`) for tier-based
approval flow, or a plain executor for tests.

**Why**: matches plan A.6 — tier enforcement lives in runtime's
`ToolExecutor` impl, shell owns approval UI via `ApprovalBroker`.

Ref: careti's `needsApproval(call.name)` → `waitForApproval(...)` pattern,
but factored behind an interface rather than inlined.

### D6. Memory `encode` at turn end, `recall` at turn start

- Turn start: `recall(userText, { topK: 5 })` — injects memory hits into system prompt
- Turn end: `encode(userText, "user")` + `encode(assistantText, "assistant")`

**Why**: minimum viable bidirectional flow. Advanced hooks (mid-stream
encoding, selective tool-result encoding) are deferred to a future
iteration. The contract allows them — any memory that wants stream-level
granularity can add a sub-capability.

Note: `encode()` errors are caught and logged but do not fail the turn —
memory is non-critical to the user-visible response.

### D7. Session lifecycle owned by Agent

Agent owns a `Session` object, transitions it through `ALLOWED_TRANSITIONS`
from `@nextain/agent-types/session.ts`. Emits `session.{created,active,...}`
events via Logger. `close()` transitions to `closed` and calls
`memory.close()`.

**Why**: plan A.5 — `naia-agent/core` owns session transition logic;
storage lives elsewhere.

### D8. `AgentStreamEvent` union surfaces every observable

```ts
type AgentStreamEvent =
  | { type: "session.started"; session }
  | { type: "turn.started"; userText; recalled }
  | { type: "llm.chunk"; chunk }
  | { type: "tool.started"; invocation }
  | { type: "tool.ended"; invocation; result }
  | { type: "compaction"; droppedCount; realtime }
  | { type: "usage"; usage }
  | { type: "turn.ended"; assistantText }
  | { type: "session.ended"; state };
```

**Why**: lets hosts (TUI, web UI, logging) observe internal transitions
without bolting event listeners. `llm.chunk` forwards the raw
`LLMStreamChunk` for low-level cases (token-by-token rendering).

Ref: opencode's BusEvent is more elaborate (publish-subscribe across
services); we use a yielded union for a simpler embedded story.

## Alpha-memory integration roadmap

| Now (v0.1) | Next | Future |
|---|---|---|
| `encode`/`recall`/`consolidate`/`close` | `compact()` via `CompactableCapable` | Real-time compaction hook: memory observes LLM stream, maintains rolling summary, `compact()` returns instantly |
| Background consolidation (30 min) | On-demand `consolidateNow()` triggered by agent | Per-turn micro-consolidation (light, predictable) |
| Recall via vector search | Recall biased by current session | Attention-aware recall (what was just said) |
| — | Sub-capabilities discoverable via `isCapable()` | Capability registry auto-populated |

## Deferred / follow-up

- Real tokenizer integration (provider-accurate counts). Currently chars/4
- `sub-agent` spawning (claude-code pattern). Agent is single-level today
- MCP bridge via runtime (X4, continuation of #200)
- Prompt caching strategy — passthrough today, opinionated policy pending
- Multi-session concurrency within a host — one HostContext = one Session (plan A.12)

## Testing surface

Current: `scripts/smoke-anthropic.ts` exercises `AnthropicClient` directly
(not `Agent`). An `Agent`-level smoke (InMemoryMemory + Mock LLM + Mock
Tools) lands in a follow-up commit once bash is available to run builds.
