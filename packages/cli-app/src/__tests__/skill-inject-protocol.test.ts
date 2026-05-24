import { describe, it, expect } from "vitest";
import {
  CompositeToolExecutor,
} from "@nextain/agent-runtime";
import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "@nextain/agent-types";

function mockProxyExecutor(
  defs: ToolDefinitionWithTier[],
): ToolExecutor {
  return {
    list: async () => defs,
    execute: async (inv: ToolInvocation): Promise<ToolExecutionResult> => ({
      content: `proxy:${inv.name}`,
    }),
  };
}

describe("Host skill injection via CompositeToolExecutor (4-D pattern)", () => {
  const coreDef: ToolDefinitionWithTier = { name: "bash", description: "core bash", inputSchema: {}, tier: "T1" };
  const hostDef1: ToolDefinitionWithTier = { name: "browser", description: "host browser", inputSchema: {}, tier: "T0" };
  const hostDef2: ToolDefinitionWithTier = { name: "tts", description: "host tts", inputSchema: {}, tier: "T0" };

  it("core tools available when no host injection", async () => {
    const core = mockProxyExecutor([coreDef]);
    const c = new CompositeToolExecutor({ subs: [{ id: "builtins", executor: core }] });
    const list = await c.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("bash");
  });

  it("host injection adds tools alongside core", async () => {
    const core = mockProxyExecutor([coreDef]);
    const host = mockProxyExecutor([hostDef1, hostDef2]);
    const c = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: core },
        { id: "host", executor: host },
      ],
    });
    const list = await c.list();
    expect(list).toHaveLength(3);
    const names = list.map((d) => d.name).sort();
    expect(names).toEqual(["bash", "browser", "tts"]);
  });

  it("host override wins over core for same tool name", async () => {
    const coreWeather: ToolDefinitionWithTier = { name: "weather", description: "core weather", inputSchema: {}, tier: "T0" };
    const hostWeather: ToolDefinitionWithTier = { name: "weather", description: "host weather", inputSchema: {}, tier: "T0" };
    const core = mockProxyExecutor([coreWeather]);
    const host = mockProxyExecutor([hostWeather]);
    const c = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: core },
        { id: "host", executor: host },
      ],
    });
    const list = await c.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.description).toBe("host weather");
    expect(c.ownerOf("weather")).toBe("host");
  });

  it("dynamic injection: replace host sub with new defs", async () => {
    const hostDefs: ToolDefinitionWithTier[] = [
      { name: "browser", description: "v1", inputSchema: {}, tier: "T0" },
    ];
    const hostExec: ToolExecutor = {
      list: async () => [...hostDefs],
      execute: async (inv: ToolInvocation): Promise<ToolExecutionResult> => ({
        content: `host:${inv.name}`,
      }),
    };
    const core = mockProxyExecutor([coreDef]);
    const c = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: core },
        { id: "host", executor: hostExec },
      ],
    });

    let list = await c.list();
    expect(list).toHaveLength(2);

    hostDefs.push({ name: "tts", description: "v1", inputSchema: {}, tier: "T0" });
    hostDefs[0]!.description = "v2";

    list = await c.list();
    expect(list).toHaveLength(3);
    expect(list.find((d) => d.name === "browser")!.description).toBe("v2");
  });

  it("execute routes to host for injected tool", async () => {
    const core = mockProxyExecutor([coreDef]);
    const host = mockProxyExecutor([hostDef1]);
    const c = new CompositeToolExecutor({
      subs: [
        { id: "builtins", executor: core },
        { id: "host", executor: host },
      ],
    });
    await c.list();
    const result = await c.execute({ id: "t1", name: "browser", input: {}, tier: "T0" });
    expect(result.content).toBe("proxy:browser");
  });
});
