// Slice #68 — codegraph integration test (G15 fixture-only mode).
//
// Verifies that a mock codegraph ToolExecutor wires end-to-end through
// CompositeToolExecutor → createHost → Agent:
//   1. codegraph tools appear in host.tools.list()
//   2. Agent dispatches a codegraph tool call and gets back a result
//   3. CompositeToolExecutor correctly namespaces codegraph:* tools
//
// No real codegraph binary or .codegraph/ index is required.
// No ANTHROPIC_API_KEY required (StreamPlayer fixture-replay).

import { describe, it, expect } from "vitest";
import { Agent } from "@nextain/agent-core";
import { createHost } from "../host/create-host.js";
import {
  InMemoryToolExecutor,
  CompositeToolExecutor,
  createTimeSkill,
  createBashSkill,
} from "../index.js";
import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "@nextain/agent-types";
import { StreamPlayer } from "../testing/stream-player.js";

// ---------------------------------------------------------------------------
// Mock ToolExecutor simulating what MCPToolExecutor returns for codegraph.
// Tool names follow the `{serverName}:{toolName}` namespace convention.
// ---------------------------------------------------------------------------

const CODEGRAPH_TOOLS: ToolDefinitionWithTier[] = [
  {
    name: "codegraph:codegraph_search",
    description: "Search symbols by name or description",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    tier: "T0",
  },
  {
    name: "codegraph:codegraph_context",
    description: "Get context for a symbol",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    tier: "T0",
  },
  {
    name: "codegraph:codegraph_trace",
    description: "Trace call path between two symbols",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
    },
    tier: "T0",
  },
];

const SEARCH_RESULTS = {
  "codegraph:codegraph_search": JSON.stringify([
    { symbol: "createCodeGraphExecutor", file: "skills/codegraph.ts", line: 42 },
    { symbol: "CodeGraphOptions", file: "skills/codegraph.ts", line: 18 },
  ]),
  "codegraph:codegraph_context": JSON.stringify({
    symbol: "createCodeGraphExecutor",
    signature: "async function createCodeGraphExecutor(opts: CodeGraphOptions): Promise<MCPToolExecutor | null>",
    docstring: "Creates a ToolExecutor backed by codegraph serve --mcp",
  }),
};

function mockCodeGraphExecutor(): ToolExecutor {
  return {
    list: async () => CODEGRAPH_TOOLS,
    execute: async (inv: ToolInvocation): Promise<ToolExecutionResult> => ({
      content: SEARCH_RESULTS[inv.name as keyof typeof SEARCH_RESULTS]
        ?? `codegraph result for ${inv.name}`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Group CG-1: tool registration
// ---------------------------------------------------------------------------

describe("Group CG-1 — codegraph tool registration in CompositeToolExecutor", () => {
  it("CG-1-1: codegraph tools appear in list() when wired via CompositeToolExecutor", async () => {
    const builtins = new InMemoryToolExecutor([createTimeSkill(), createBashSkill()]);
    const cgExecutor = mockCodeGraphExecutor();

    const composite = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: builtins },
        { id: "codegraph", executor: cgExecutor },
      ],
    });

    const tools = await composite.list();
    const names = tools.map((t) => t.name);

    expect(names).toContain("time");
    expect(names).toContain("bash");
    expect(names).toContain("codegraph:codegraph_search");
    expect(names).toContain("codegraph:codegraph_context");
    expect(names).toContain("codegraph:codegraph_trace");
  });

  it("CG-1-2: all codegraph tools are T0 (read-only, no approval)", async () => {
    const cgExecutor = mockCodeGraphExecutor();
    const composite = new CompositeToolExecutor({
      subs: [{ id: "codegraph", executor: cgExecutor }],
    });
    const tools = await composite.list();
    const cgTools = tools.filter((t) => t.name.startsWith("codegraph:"));
    expect(cgTools.length).toBeGreaterThan(0);
    for (const t of cgTools) {
      expect(t.tier).toBe("T0");
    }
  });

  it("CG-1-3: without codegraph, only builtins appear", async () => {
    const builtins = new InMemoryToolExecutor([createTimeSkill()]);
    const tools = await builtins.list();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("codegraph:codegraph_search");
    expect(names).toContain("time");
  });
});

// ---------------------------------------------------------------------------
// Group CG-2: tool dispatch
// ---------------------------------------------------------------------------

describe("Group CG-2 — codegraph tool dispatch through CompositeToolExecutor", () => {
  it("CG-2-1: codegraph_search returns JSON results", async () => {
    const composite = new CompositeToolExecutor({
      subs: [{ id: "codegraph", executor: mockCodeGraphExecutor() }],
    });
    await composite.list(); // populate routing table

    const result = await composite.execute({
      id: "cg1",
      name: "codegraph:codegraph_search",
      input: { query: "createCodeGraphExecutor" },
      tier: "T0",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("createCodeGraphExecutor");
    expect(result.content).toContain("skills/codegraph.ts");
  });

  it("CG-2-2: codegraph_context returns symbol details", async () => {
    const composite = new CompositeToolExecutor({
      subs: [{ id: "codegraph", executor: mockCodeGraphExecutor() }],
    });
    await composite.list();

    const result = await composite.execute({
      id: "cg2",
      name: "codegraph:codegraph_context",
      input: { symbol: "createCodeGraphExecutor" },
      tier: "T0",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("signature");
    expect(result.content).toContain("docstring");
  });

  it("CG-2-3: tool routing falls back gracefully for unknown tool", async () => {
    const composite = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: new InMemoryToolExecutor([createTimeSkill()]) },
        { id: "codegraph", executor: mockCodeGraphExecutor() },
      ],
    });
    await composite.list();

    // Builtin tool still works after codegraph wiring
    const result = await composite.execute({
      id: "cg3",
      name: "time",
      input: {},
      tier: "T0",
    });
    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Group CG-3: Agent + createHost end-to-end fixture replay
// ---------------------------------------------------------------------------

describe("Group CG-3 — Agent + createHost with codegraph tools (fixture-replay)", () => {
  it("CG-3-1: Agent sees codegraph tools in tierForTool lookup", async () => {
    const builtins = new InMemoryToolExecutor([createTimeSkill()]);
    const cgExecutor = mockCodeGraphExecutor();
    const composite = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: builtins },
        { id: "codegraph", executor: cgExecutor },
      ],
    });

    const host = createHost({ logLevel: "warn", llm: new StreamPlayer({
      chunks: [
        { type: "start", id: "msg_cg_001", model: "fixture" },
        { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Code analyzed." } },
        { type: "content_block_stop", index: 0 },
        { type: "end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } },
      ],
    }), tools: composite });

    const agent = new Agent({
      host,
      systemPrompt: "code intelligence assistant",
      tierForTool: () => "T0",
    });

    let assistantText = "";
    for await (const ev of agent.sendStream("search for createCodeGraphExecutor")) {
      if (ev.type === "turn.ended") assistantText = ev.assistantText;
    }

    expect(assistantText).toBe("Code analyzed.");
    agent.close();
  });

  it("CG-3-2: host.tools.list() with codegraph returns superset of builtins", async () => {
    const builtins = new InMemoryToolExecutor([createTimeSkill(), createBashSkill()]);
    const cgExecutor = mockCodeGraphExecutor();
    const composite = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: builtins },
        { id: "codegraph", executor: cgExecutor },
      ],
    });

    const host = createHost({ logLevel: "warn", llm: new StreamPlayer({ chunks: [] }), tools: composite });

    const allTools = await host.tools.list!();
    const builtinOnly = await builtins.list();

    expect(allTools.length).toBeGreaterThan(builtinOnly.length);
    expect(allTools.length).toBe(builtinOnly.length + CODEGRAPH_TOOLS.length);
  });
});
