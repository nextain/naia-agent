# Hosting an Agent — Developer Guide

This guide shows how to build a host that embeds `@nextain/agent-core`'s
`Agent`. It does not assume prior familiarity with naia-agent; it does
assume TypeScript + Node ≥ 22.

Five minutes to first run; twenty minutes to a production-shaped host.

## Minimum viable host (15 lines)

```ts
import { Agent } from "@nextain/agent-core";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
import { InMemoryMemory, InMemoryToolExecutor, MockLLMClient } from "@nextain/agent-runtime";

const agent = new Agent({
  host: {
    llm: new MockLLMClient({ turns: [{ blocks: "hello", stopReason: "end_turn" }] }),
    memory: new InMemoryMemory(),
    tools: new InMemoryToolExecutor(),
    logger: new ConsoleLogger(),
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
    approvals: { async decide() { throw new Error("not wired"); } },
    identity: { deviceId: "dev", publicKeyEd25519: "dev", async sign() { throw new Error("not wired"); } },
  },
});

console.log(await agent.send("hello agent"));
```

## Swapping in a real LLM — Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient } from "@nextain/agent-providers/anthropic";

const llm = new AnthropicClient(
  new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  { defaultModel: "claude-haiku-4-5-20251001" },
);
```

Pass `llm` into the `host` object above; everything else stays the same.

## Swapping in real memory — alpha-memory

```ts
import { LocalAdapter, MemorySystem } from "@nextain/alpha-memory";

const sys = new MemorySystem({
  adapter: new LocalAdapter("~/.naia/memory.json"),
  // Optional: LLM-backed summarizer for compact()
  // summarizer: async ({ messages, seedSummary }) => { ... },
});

// Wrap in a thin adapter that maps context types. See
// examples/alpha-memory-host.ts for the complete AlphaMemoryAdapter.
```

Alpha-memory implements `CompactableCapable` — when the Agent's
contextBudget is exceeded, it calls `memory.compact()` which uses the
rolling summary path for instant, precomputed results.

## Exposing skills as tools

naia-adk workspaces put skills under `.agents/skills/<name>/SKILL.md`.
Two lines wire them up as LLM-visible tools:

```ts
import { FileSkillLoader, SkillToolExecutor } from "@nextain/agent-runtime";

const loader = new FileSkillLoader({
  workspaceRoot: "./my-workspace",
  invoker: async (desc, input) => ({ content: await runSkill(desc, input.args) }),
});
const tools = new SkillToolExecutor({ loader });
```

Pass `tools` into the host. The Agent's LLM will see every SKILL.md
in the workspace as a tool.

## Adding MCP servers

```ts
import { MCPClient, MCPToolExecutor } from "@nextain/agent-runtime";

const github = new MCPClient({
  name: "github",
  command: "mcp-server-github",
  defaultTier: "T2",
});
await github.connect();

const tools = new MCPToolExecutor([github]);
```

MCP tools are namespaced `server:tool` to prevent collisions. Mix with
skills via `CompositeToolExecutor`:

```ts
import { CompositeToolExecutor } from "@nextain/agent-runtime";

const tools = new CompositeToolExecutor({
  subs: [
    { id: "skills", executor: new SkillToolExecutor({ loader }) },
    { id: "mcp", executor: new MCPToolExecutor([github]) },
  ],
});
```

**Sub order is a trust boundary**: list skills before MCP so an
attacker-controlled MCP server cannot shadow a built-in skill of the
same name. `CompositeToolExecutor` warns on every shadowing event.

## Observing the stream

`sendStream()` yields structured events for every transition:

```ts
for await (const ev of agent.sendStream("solve this")) {
  switch (ev.type) {
    case "text":          // token from text_delta
    case "thinking":      // token from thinking_delta
    case "tool.started":  // tool.name / invocation.input
    case "tool.ended":    // invocation / result
    case "compaction":    // droppedCount / realtime (precomputed?)
    case "usage":         // input/output/cache tokens
    case "turn.ended":    // assistantText (final)
    case "tool.error.halt": // ≥ N consecutive tool errors → turn stopped
  }
}
```

**Channel duplication note**: `llm.chunk` carries the raw SDK stream
and `text`/`thinking` are convenience derivatives of the same deltas.
Subscribe to one channel, not both.

## Approvals & tiers

Skills and tools declare a tier (T0/T1/T2/T3). The Agent's
`ToolExecutor.execute()` doesn't enforce policy by itself — wrap with
`GatedToolExecutor` for approval-gating:

```ts
import { GatedToolExecutor } from "@nextain/agent-runtime";

const gated = new GatedToolExecutor({
  inner: tools,
  approvals: hostApprovalBroker, // your UI-backed broker
  requireApproval: new Set(["T2", "T3"]),
});
```

`ApprovalBroker` is a HostContext field — your broker presents the
request to the user (CLI prompt, Tauri modal, HTTP push, …) and
resolves with `{ status: "approved" | "denied" | "timeout" }`.

## Long-running sessions

- Agent auto-compacts when `estimateTokens(request)` exceeds
  `contextBudget` (default 80_000). Delegates to `memory.compact()`
  when memory implements `CompactableCapable`; otherwise slides
  the history window.
- `maxConsecutiveToolErrors` (default 3) stops the turn if tools keep
  failing. Surfaced via `tool.error.halt` event.
- `agent.close()` transitions the session to `closed` but does NOT
  close the shared `memory` — host owns `memory.close()`.

## Real-time compaction (alpha-memory v2)

When alpha-memory's `MemorySystem.compact()` receives a known
`sessionId`, it returns the per-session rolling summary maintained
during `encode()` with `realtime: true`. The Agent forwards this flag
in the `compaction` event so UIs can show "summary was instant" vs.
"summary was freshly generated".

Ensure your adapter forwards `sessionId`:

```ts
async encode(input) {
  await sys.encode(
    { content: input.content, role: input.role, ... },
    { sessionId: input.context?.sessionId },
  );
}
```

## Full worked examples (repo)

Reference hosts under `examples/`:

| File | Demonstrates |
|---|---|
| `minimal-host.ts` | One-turn tool-hop with mocks |
| `compaction-host.ts` | `CompactableCapable` with a mock memory |
| `alpha-memory-host.ts` | Full alpha-memory + sessionId + rolling summary + durability |
| `tool-error-halt.ts` | Consecutive-error halt behaviour |
| `skill-loader-host.ts` | SKILL.md YAML parsing |
| `skill-tool-host.ts` | Skills as first-class tools |
| `composite-host.ts` | Multi-executor composition + shadow warnings |

Run any with `pnpm exec tsx examples/<name>.ts`.

## Package overview

| Package | Purpose |
|---|---|
| `@nextain/agent-types` | Zero-dep contracts (LLMClient, MemoryProvider, ToolExecutor, Event, …) |
| `@nextain/agent-protocol` | Wire protocol (stdio frame) |
| `@nextain/agent-core` | Agent loop |
| `@nextain/agent-runtime` | Helpers: GatedToolExecutor, FileSkillLoader, SkillToolExecutor, MCPClient, CompositeToolExecutor, mocks |
| `@nextain/agent-providers` | LLMClient impls (AnthropicClient) |
| `@nextain/agent-observability` | Default Logger/Tracer/Meter |
| `@naia-adk/skill-spec` | SKILL.md format spec |
| `@nextain/alpha-memory` | MemoryProvider reference impl |

## License

Apache 2.0.
