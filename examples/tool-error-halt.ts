/**
 * tool-error-halt — verifies Agent stops after N consecutive tool errors.
 *
 * Scenario:
 *   - `always-fails` tool registered, always returns isError:true
 *   - MockLLMClient scripted to call it repeatedly
 *   - Agent should emit tool.error.halt after 3 consecutive errors
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

const llm = new MockLLMClient({
  turns: Array.from({ length: 6 }, (_, i) => ({
    blocks: [
      {
        type: "tool_use" as const,
        id: `call_${i + 1}`,
        name: "always-fails",
        input: {},
      },
    ],
    stopReason: "tool_use" as const,
  })),
});

const tools = new InMemoryToolExecutor([
  {
    name: "always-fails",
    description: "Always fails.",
    inputSchema: { type: "object" },
    tier: "T0",
    handler: () => {
      throw new Error("intentional failure");
    },
  },
]);

const host: HostContext = {
  llm,
  memory: new InMemoryMemory(),
  tools,
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
  const agent = new Agent({
    host,
    tierForTool: () => "T0",
    maxToolHops: 20,
  });

  let haltEvents = 0;
  let toolErrors = 0;
  let finalText = "";
  for await (const ev of agent.sendStream("Please run the failing tool.")) {
    if (ev.type === "tool.ended" && ev.result.isError) toolErrors++;
    if (ev.type === "tool.error.halt") haltEvents++;
    if (ev.type === "turn.ended") finalText = ev.assistantText;
  }

  agent.close();

  console.log("\n━━━ tool-error-halt results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  tool errors observed: ${toolErrors}`);
  console.log(`  halt events: ${haltEvents}`);
  console.log(`  final text: ${finalText}`);

  if (haltEvents !== 1) {
    console.error("FAIL: expected exactly 1 halt event");
    process.exit(1);
  }
  if (toolErrors < 3 || toolErrors > 4) {
    console.error(`FAIL: expected 3-4 tool errors before halt, got ${toolErrors}`);
    process.exit(1);
  }
  console.log("\n✓ tool-error halt behaviour confirmed");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
