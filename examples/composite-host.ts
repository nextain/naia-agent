/**
 * composite-host — verifies CompositeToolExecutor routes correctly.
 *
 * Wires two sub-executors:
 *   - "skills": InMemoryToolExecutor with a `greet` tool (simulates SkillToolExecutor)
 *   - "mcp":    InMemoryToolExecutor with a `search` tool (simulates MCPToolExecutor)
 *
 * LLM is scripted to call both. Verifies:
 *   - list() aggregates both sub-executors
 *   - each invocation routes to the owning sub
 *   - ownerOf() reports correct sub
 *   - duplicate name detection (first-registered wins)
 */

import { Agent } from "@nextain/agent-core";
import type { HostContext } from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import {
  CompositeToolExecutor,
  InMemoryMemory,
  InMemoryToolExecutor,
  MockLLMClient,
} from "@nextain/agent-runtime";

const skillsExecutor = new InMemoryToolExecutor([
  {
    name: "greet",
    description: "Skill-side greet.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    tier: "T0",
    handler: (input) => `SKILLS: hello ${(input as { name: string }).name}`,
  },
]);
const mcpExecutor = new InMemoryToolExecutor([
  {
    name: "search",
    description: "MCP-side search.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    tier: "T1",
    handler: (input) => `MCP: results for "${(input as { q: string }).q}"`,
  },
  // Collision test — will be shadowed by skills' "greet" (registered first).
  {
    name: "greet",
    description: "MCP-side greet (should be shadowed).",
    inputSchema: { type: "object" },
    tier: "T1",
    handler: () => "MCP: hello",
  },
]);

const composite = new CompositeToolExecutor([
  { id: "skills", executor: skillsExecutor },
  { id: "mcp", executor: mcpExecutor },
]);

const llm = new MockLLMClient({
  turns: [
    {
      blocks: [
        { type: "tool_use", id: "c1", name: "greet", input: { name: "world" } },
      ],
      stopReason: "tool_use",
    },
    {
      blocks: [
        { type: "tool_use", id: "c2", name: "search", input: { q: "naia" } },
      ],
      stopReason: "tool_use",
    },
    { blocks: "Composite routing verified.", stopReason: "end_turn" },
  ],
});

const host: HostContext = {
  llm,
  memory: new InMemoryMemory(),
  tools: composite,
  logger: new ConsoleLogger({ level: "warn" }),
  tracer: new NoopTracer(),
  meter: new InMemoryMeter(),
  approvals: {
    async decide() {
      throw new Error("not wired");
    },
  },
  identity: {
    deviceId: "mock",
    publicKeyEd25519: "mock",
    async sign() {
      throw new Error("not wired");
    },
  },
};

async function main(): Promise<void> {
  const listing = await composite.list();
  console.log("━━━ composite list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const d of listing) {
    console.log(`  ${d.name} (tier=${d.tier}) owner=${composite.ownerOf(d.name)}`);
  }
  if (listing.length !== 2) {
    console.error(`FAIL: expected 2 aggregated tools (greet deduped + search), got ${listing.length}`);
    process.exit(1);
  }
  if (composite.ownerOf("greet") !== "skills") {
    console.error(`FAIL: greet should be owned by "skills" (first-registered), got "${composite.ownerOf("greet")}"`);
    process.exit(1);
  }
  if (composite.ownerOf("search") !== "mcp") {
    console.error(`FAIL: search should be owned by "mcp", got "${composite.ownerOf("search")}"`);
    process.exit(1);
  }

  const agent = new Agent({ host });
  const routedContents: string[] = [];
  for await (const ev of agent.sendStream("Use both tools.")) {
    if (ev.type === "tool.ended") {
      routedContents.push(ev.result.content);
      console.log(`[tool ${ev.invocation.name}] ${ev.result.content}`);
    }
  }
  agent.close();

  if (!routedContents[0]?.startsWith("SKILLS:")) {
    console.error(`FAIL: greet should route to skills, got "${routedContents[0]}"`);
    process.exit(1);
  }
  if (!routedContents[1]?.startsWith("MCP:")) {
    console.error(`FAIL: search should route to mcp, got "${routedContents[1]}"`);
    process.exit(1);
  }

  console.log("\n✓ CompositeToolExecutor routing verified");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
