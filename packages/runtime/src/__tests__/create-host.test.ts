// Slice 1a sub-3 — host factory unit tests (#11).
// Verifies createHost() defaults + DI overrides.

import { describe, it, expect } from "vitest";
import { Agent } from "@nextain/agent-core";
import { createHost } from "../host/create-host.js";
import { InMemoryToolExecutor } from "../mocks/in-memory-tool-executor.js";

describe("createHost (Slice 1a)", () => {
  it("returns a fully-wired HostContext with mock defaults", () => {
    const host = createHost();
    expect(host.llm).toBeDefined();
    expect(host.memory).toBeDefined();
    expect(host.tools).toBeDefined();
    expect(host.logger).toBeDefined();
    expect(host.tracer).toBeDefined();
    expect(host.meter).toBeDefined();
    expect(host.approvals).toBeDefined();
    expect(host.identity).toBeDefined();
  });

  it("Agent constructed with default host runs end-to-end (mock LLM)", async () => {
    const host = createHost({ logLevel: "warn" });
    const agent = new Agent({
      host,
      systemPrompt: "test",
      tierForTool: () => "T0",
    });

    let assistantText = "";
    let endedCount = 0;
    for await (const ev of agent.sendStream("hello")) {
      if (ev.type === "turn.ended") {
        assistantText = ev.assistantText;
        endedCount += 1;
      }
    }

    expect(endedCount).toBe(1);
    expect(assistantText).toContain("naia-agent in mock mode");
    agent.close();
  });

  it("accepts custom mockScript", async () => {
    const host = createHost({
      logLevel: "warn",
      mockScript: {
        turns: [{ blocks: "custom answer", stopReason: "end_turn" }],
      },
    });
    const agent = new Agent({ host, tierForTool: () => "T0" });

    let assistantText = "";
    for await (const ev of agent.sendStream("anything")) {
      if (ev.type === "turn.ended") assistantText = ev.assistantText;
    }
    expect(assistantText).toBe("custom answer");
    agent.close();
  });

  it("respects custom tools override", () => {
    const customTools = new InMemoryToolExecutor([]);
    const host = createHost({ tools: customTools });
    expect(host.tools).toBe(customTools);
  });

  it("approvals/identity throw when accessed (T1+ unwired)", async () => {
    const host = createHost();
    await expect(
      host.approvals.decide({
        id: "req-1",
        tier: "T2",
        invocation: {
          id: "c1",
          name: "x",
          input: {},
          tier: "T2",
        },
      }),
    ).rejects.toThrow(/approvals not wired/);

    await expect(host.identity.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /sign\(\) not wired/,
    );
  });
});
