/**
 * Minimal host — runs an Agent with entirely in-process mocks.
 * Proves the Phase 2 X3 Agent class end-to-end without any network.
 *
 * Run:
 *   pnpm exec tsx examples/minimal-host.ts
 *
 * What it exercises:
 *   - Agent constructor + HostContext wiring
 *   - sendStream() yielding session/turn/llm.chunk/tool.started/ended events
 *   - Tool-hop loop with input_json_delta → tool_use.input assembly
 *   - Memory recall+encode across turns
 *   - session lifecycle (created → active → closed)
 *
 * This file is not published; it is an example only.
 */

import { Agent } from "@nextain/agent-core";
import type { HostContext } from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import {
  InMemoryMemory,
  InMemoryToolExecutor,
  MockLLMClient,
} from "@nextain/agent-runtime";

// Scripted 2-turn conversation with a tool call in between.
const llm = new MockLLMClient({
  turns: [
    // Turn 1: model decides to call the `echo` tool.
    {
      blocks: [
        { type: "text", text: "Let me use the echo tool." },
        {
          type: "tool_use",
          id: "call_1",
          name: "echo",
          input: { message: "hello-from-mock" },
        },
      ],
      stopReason: "tool_use",
    },
    // Turn 2: after tool_result, final answer.
    {
      blocks: "Tool returned the expected echo.",
      stopReason: "end_turn",
    },
  ],
});

// In-memory tool that echoes its input.
const tools = new InMemoryToolExecutor([
  {
    name: "echo",
    description: "Echoes the input message.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    tier: "T0",
    handler: (input) => {
      const { message } = input as { message: string };
      return `ECHO: ${message}`;
    },
  },
]);

const memory = new InMemoryMemory();

// Minimal host: stub out approvals/identity. Agent does not call them for
// T0 tools so we leave them as throwing shims to surface misuse loudly.
const host: HostContext = {
  llm,
  memory,
  tools,
  logger: new ConsoleLogger({ level: "info" }),
  tracer: new NoopTracer(),
  meter: new InMemoryMeter(),
  approvals: {
    async decide() {
      throw new Error("minimal-host: approvals not wired (T0 only)");
    },
  },
  identity: {
    deviceId: "mock-device",
    publicKeyEd25519: "mock-pubkey",
    async sign() {
      throw new Error("minimal-host: sign() not wired");
    },
  },
};

async function main(): Promise<void> {
  const agent = new Agent({
    host,
    systemPrompt: "You are a test assistant running inside minimal-host.",
    tierForTool: () => "T0",
  });

  console.log("\n━━━ Turn 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const events: string[] = [];
  for await (const ev of agent.sendStream("Please echo hello-from-mock")) {
    events.push(ev.type);
    if (ev.type === "turn.ended") {
      console.log(`\n[final] ${ev.assistantText}`);
    } else if (ev.type === "tool.started") {
      console.log(`[tool ▶] ${ev.invocation.name}(${JSON.stringify(ev.invocation.input)})`);
    } else if (ev.type === "tool.ended") {
      console.log(`[tool ◀] ${ev.invocation.name} → ${ev.result.content}`);
    } else if (ev.type === "compaction") {
      console.log(`[compact] dropped=${ev.droppedCount} realtime=${ev.realtime}`);
    }
  }
  console.log(`\nevents: ${events.join(" → ")}`);

  console.log("\n━━━ Memory snapshot ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const r of memory.snapshot()) {
    console.log(`  [${r.role}] ${r.content.slice(0, 60)}`);
  }

  console.log("\n━━━ Session ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  id=${agent.session.id} state=${agent.session.state}`);
  agent.close();
  console.log(`  after close: state=${agent.session.state}`);

  // Success criteria:
  //  - at least one "tool.started" + "tool.ended" event fired
  //  - memory snapshot has 2 records (user + assistant)
  const sawTool = events.includes("tool.started") && events.includes("tool.ended");
  const mems = memory.snapshot();
  const sawTurn = mems.length >= 2;
  if (!sawTool || !sawTurn) {
    console.error("\nFAIL: smoke expectations not met");
    console.error(`  tool events: ${sawTool}`);
    console.error(`  memory records: ${mems.length}`);
    process.exit(1);
  }
  console.log("\n✓ minimal-host smoke passed");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
