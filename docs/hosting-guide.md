# Hosting an Agent — Developer Guide

> **Languages**: English (this file) · [한국어](../.users/docs/ko/hosting-guide.md)

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

Every field on `host` is required — this is the canonical `HostContext`
shape (`@nextain/agent-types`):

| Field | Purpose |
|---|---|
| `llm` | `LLMClient` — provider call (Anthropic / OpenAI-compat / Vertex / Claude Code subscription) |
| `memory` | `MemoryProvider` — encode / recall / consolidate / close |
| `tools` | `ToolExecutor` — skills, bash, MCP, file-ops, or a composite |
| `logger` | structured logger (level-aware) |
| `tracer` | OpenTelemetry-compatible tracer (`NoopTracer` for tests) |
| `meter` | metric meter (`InMemoryMeter` for tests) |
| `approvals` | `ApprovalBroker` — host-owned approval UI for T2/T3 tools |
| `identity` | device key + `sign()` for tamper-evident audit |

Helpers (`InMemoryMemory`, `InMemoryToolExecutor`, `MockLLMClient`,
`NoopTracer`, `InMemoryMeter`, `ConsoleLogger`) make the no-real-backend
path one import.

## Swapping in a real LLM

For most hosts, **prefer the cross-repo 3-role config** in
`naia-adk/naia-settings/llm.json` (the SoT) instead of hand-wiring a
provider. See `docs/llm-config-standard.md` for the standard.

When the host needs to construct an `LLMClient` directly, use one of
the supplied clients in `@nextain/agent-providers`:

```ts
import { VercelClient } from "@nextain/agent-providers";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const llm = new VercelClient(anthropic("claude-haiku-4-5-20251001"));
```

Equivalent patterns work for OpenAI-compat gateways, Vertex AI, and the
Claude Code subscription provider (`ai-sdk-provider-claude-code`,
`backend:"claude-code"` — no API key, subscription credit). The `bin/`
entry point dispatches all four backends in `buildLLMClientFromManifest`
in `bin/naia-agent.ts`.

## Swapping in real memory — naia-memory

```ts
import { LiteMemoryProvider, OpenAICompatEmbeddingProvider } from "@nextain/naia-memory";

const embedder = new OpenAICompatEmbeddingProvider({
  baseURL: process.env.NAIA_EMBED_BASE_URL,
  model: process.env.NAIA_EMBED_MODEL,
  dims: Number(process.env.NAIA_EMBED_DIMS ?? 1024),
});
const memory = new LiteMemoryProvider({
  dbPath: "memory.sqlite",
  embedder,
  writesEnabled: true,
});
```

`LiteMemoryProvider` implements `MemoryProvider` and the optional
`CompactableCapable` interface — when the Agent's `contextBudget` is
exceeded, it calls `memory.compact()` which uses the rolling summary
path for instant, precomputed results.

The blessed end-to-end example (sqlite + offline embedding) is
`examples/hardened-sqlite-host.ts`. The CLI itself uses this stack via
the `--memory` flag (Slice 3-XR-C).

## Exposing skills as tools

naia-adk workspaces put skills under top-level `skills/<name>/SKILL.md`.
Two lines wire them up as LLM-visible tools:

```ts
import { FileSkillLoader, SkillToolExecutor } from "@nextain/agent-runtime";

const loader = new FileSkillLoader({
  workspaceRoot: "./my-workspace",
  skillsDir: "./my-workspace/skills",
  invoker: async (desc, input) => ({ content: await runSkill(desc, input.args) }),
});
const tools = new SkillToolExecutor({ loader });
```

Pass `tools` into the host. The Agent's LLM will see every `SKILL.md`
in the directory as a tool. The CLI exposes the same loader through
`--skills-dir <path>` (Slice 3-XR-J), and the mechanism is ADK-agnostic
— Slice 3-XR-L verified onmam-adk on the same surface with zero core
change.

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

MCP tools are namespaced `server:tool` to prevent collisions.

## Composite tool executor (bash + file-ops + skills + MCP)

Real hosts almost always mix several executors. The CLI itself runs a
composite of built-ins plus an optional ADK skills loader:

```ts
import {
  CompositeToolExecutor,
  InMemoryToolExecutor,
  createBashSkill,
  createFileOpsSkills,
  FileSkillLoader,
  SkillToolExecutor,
  MCPToolExecutor,
  MCPClient,
} from "@nextain/agent-runtime";

const builtins = new InMemoryToolExecutor([
  createBashSkill(),
  ...createFileOpsSkills({ workspaceRoot: "./workspace" }),
]);

const skills = new SkillToolExecutor({
  loader: new FileSkillLoader({
    workspaceRoot: "./my-adk",
    skillsDir: "./my-adk/skills",
  }),
});

const github = new MCPClient({ name: "github", command: "mcp-server-github", defaultTier: "T2" });
await github.connect();

const tools = new CompositeToolExecutor({
  subs: [
    { id: "builtins", executor: builtins },   // bash + read/write/edit/list_files
    { id: "adk-skills", executor: skills },   // naia-adk / onmam-adk top-level skills/
    { id: "mcp", executor: new MCPToolExecutor([github]) },
  ],
});
```

**Sub order is a trust boundary**: list trusted sources before less
trusted ones (built-ins → first-party ADK skills → MCP). The first
sub that registers a given name wins; later subs with the same name
are shadowed. `CompositeToolExecutor` warns on every shadowing event,
and the Slice 3-XR-L integration scenarios verify this property
(`ownerOf("channel-management") === "naia-adk"`,
`shadowedNames().length >= 9`).

`createFileOpsSkills({ workspaceRoot })` registers `read_file`,
`write_file`, `edit_file`, and `list_files` — bounded by the workspace
root via `normalizeWorkspacePath` (D09). Slice 3-XR-I LIVE-verified
the loop end-to-end with `gemma4:31b` driving the model-emitted tool
calls (Group P, 6/6).

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
and `text` / `thinking` are convenience derivatives of the same deltas.
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

`ApprovalBroker` is a `HostContext` field — your broker presents the
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

## Real-time compaction (naia-memory)

When naia-memory's `MemorySystem.compact()` receives a known
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

## Service-manifest hosting (declarative)

When the host wants to describe an agent declaratively rather than
build a `HostContext` in code, use a `*.service.json` manifest. The
`bin` entry parses, validates, and assembles everything (LLM client,
memory binding, persona) from the manifest:

```bash
pnpm naia-agent --service ./my-app.service.json "hello"
```

Supported `llm.backend` values:

| backend | Auth | Notes |
|---|---|---|
| `openai-compatible` | host env (`OPENAI_*`) | Generic OpenAI-compat / local Ollama / vLLM |
| `anthropic` | host env (`ANTHROPIC_API_KEY`) | Direct Anthropic |
| `vertex` | host env (`VERTEX_PROJECT_ID` + `VERTEX_REGION`) | Anthropic on Vertex |
| `claude-code` | Claude Code subscription (no API key) | Subscription credit; see `docs/auth-not-logged-in.md` |
| `langgraph` / `rag-retriever` | reserved | Manifest schema accepts; dispatcher deferred (Slice 3-XR-K) |

Schema SoT lives in `naia-adk/docs/service-manifest-schema.md`.

## Integration scenarios as a host reference

Slice 3-XR-G / I / J / L / M / N / O shipped a hermetic
`integration-scenarios.test.ts` + `bin-user-scenarios.test.ts`
covering 100+ user-perspective spawn-tests (live LLM, memory recall,
tool-loop, persona, secrets, service manifest, REPL, cross-OS). Read
these tests in `packages/cli-app/src/__tests__/` for production-shaped
patterns — they show how to drive the `bin` from an outer harness
and assert on stderr tool markers, file-system invariants, and
SQLite probes rather than LLM vibes.

## Full worked examples (repo)

Reference hosts under `examples/`:

| File | Demonstrates |
|---|---|
| `minimal-host.ts` | One-turn tool-hop with mocks |
| `compaction-host.ts` | `CompactableCapable` with a mock memory |
| `hardened-sqlite-host.ts` | Sqlite + offline embedding (blessed naia-memory stack) |
| `tool-error-halt.ts` | Consecutive-error halt behaviour |
| `skill-loader-host.ts` | SKILL.md YAML parsing |
| `skill-tool-host.ts` | Skills as first-class tools |
| `composite-host.ts` | Multi-executor composition + shadow warnings |

Run any with `pnpm exec tsx examples/<name>.ts`.

## Package overview

| Package | Purpose |
|---|---|
| `@nextain/agent-types` | Zero-dep contracts (`LLMClient`, `MemoryProvider`, `ToolExecutor`, `Event`, …) |
| `@nextain/agent-protocol` | Wire protocol (stdio frame) |
| `@nextain/agent-core` | Agent loop |
| `@nextain/agent-runtime` | Helpers: `GatedToolExecutor`, `FileSkillLoader`, `SkillToolExecutor`, `MCPClient`, `CompositeToolExecutor`, `createBashSkill`, `createFileOpsSkills`, mocks |
| `@nextain/agent-providers` | `LLMClient` impls (`VercelClient`, Anthropic, Vertex, Claude Code) |
| `@nextain/agent-observability` | Default `Logger` / `Tracer` / `Meter` |
| `@naia-adk/skill-spec` | `SKILL.md` format spec |
| `@nextain/naia-memory` | `MemoryProvider` reference impl |

## License

Apache 2.0.
