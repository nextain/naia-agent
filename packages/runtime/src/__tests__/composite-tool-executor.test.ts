import { describe, it, expect } from "vitest";
import { CompositeToolExecutor } from "../composite-tool-executor.js";
import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "@nextain/agent-types";

function mockExecutor(
  defs: ToolDefinitionWithTier[],
  results?: Record<string, string>,
): ToolExecutor {
  return {
    list: async () => defs,
    execute: async (inv: ToolInvocation): Promise<ToolExecutionResult> => ({
      content: results?.[inv.name] ?? `executed:${inv.name}`,
    }),
  };
}

const defA: ToolDefinitionWithTier = {
  name: "weather",
  description: "core weather",
  inputSchema: {},
  tier: "T0",
};
const defB: ToolDefinitionWithTier = {
  name: "weather",
  description: "adk weather",
  inputSchema: {},
  tier: "T0",
};
const defC: ToolDefinitionWithTier = {
  name: "weather",
  description: "host weather",
  inputSchema: {},
  tier: "T0",
};
const defD: ToolDefinitionWithTier = {
  name: "bash",
  description: "bash",
  inputSchema: {},
  tier: "T1",
};

describe("CompositeToolExecutor", () => {
  it("lists single sub tools", async () => {
    const c = new CompositeToolExecutor({
      subs: [{ id: "core", executor: mockExecutor([defD]) }],
    });
    const list = await c.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("bash");
  });

  it("last-registered wins on name collision", async () => {
    const warns: string[] = [];
    const c = new CompositeToolExecutor({
      subs: [
        { id: "core", executor: mockExecutor([defA]) },
        { id: "adk", executor: mockExecutor([defB]) },
      ],
      onWarn: (msg) => warns.push(msg),
    });
    const list = await c.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.description).toBe("adk weather");
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("overridden");
  });

  it("routes execute to last-registered owner", async () => {
    const c = new CompositeToolExecutor({
      subs: [
        { id: "core", executor: mockExecutor([defA], { weather: "core-result" }) },
        { id: "adk", executor: mockExecutor([defB], { weather: "adk-result" }) },
      ],
    });
    await c.list();
    const result = await c.execute({ id: "t1", name: "weather", input: {}, tier: "T0" });
    expect(result.content).toBe("adk-result");
  });

  it("3-layer: host > adk > core", async () => {
    const c = new CompositeToolExecutor({
      subs: [
        { id: "core", executor: mockExecutor([defA], { weather: "core" }) },
        { id: "adk", executor: mockExecutor([defB], { weather: "adk" }) },
        { id: "host", executor: mockExecutor([defC], { weather: "host" }) },
      ],
    });
    const list = await c.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.description).toBe("host weather");
    expect(c.ownerOf("weather")).toBe("host");
    const result = await c.execute({ id: "t1", name: "weather", input: {}, tier: "T0" });
    expect(result.content).toBe("host");
  });

  it("non-colliding tools from all subs appear", async () => {
    const c = new CompositeToolExecutor({
      subs: [
        { id: "core", executor: mockExecutor([defA]) },
        { id: "adk", executor: mockExecutor([defD]) },
      ],
    });
    const list = await c.list();
    expect(list).toHaveLength(2);
    const names = list.map((d) => d.name).sort();
    expect(names).toEqual(["bash", "weather"]);
  });

  it("shadowedNames reports all overrides", async () => {
    const c = new CompositeToolExecutor({
      subs: [
        { id: "core", executor: mockExecutor([defA]) },
        { id: "adk", executor: mockExecutor([defB]) },
        { id: "host", executor: mockExecutor([defC]) },
      ],
    });
    await c.list();
    const shadows = c.shadowedNames();
    expect(shadows).toHaveLength(2);
    expect(shadows[0]!.loser).toBe("core");
    expect(shadows[1]!.loser).toBe("adk");
  });

  it("execute returns error for unknown tool", async () => {
    const c = new CompositeToolExecutor({
      subs: [{ id: "core", executor: mockExecutor([defD]) }],
    });
    await c.list();
    const result = await c.execute({ id: "t1", name: "nonexistent", input: {}, tier: "T0" });
    expect(result.isError).toBe(true);
  });

  it("lazy rebuild on execute-before-list", async () => {
    const c = new CompositeToolExecutor({
      subs: [{ id: "core", executor: mockExecutor([defD], { bash: "lazy-ok" }) }],
    });
    const result = await c.execute({ id: "t1", name: "bash", input: {}, tier: "T1" });
    expect(result.content).toBe("lazy-ok");
  });
});
