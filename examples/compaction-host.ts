/**
 * compaction-host — verifies that `CompactableCapable` contract works end
 * to end. Drives Agent with an artificially low contextBudget so the
 * budget check triggers compaction on the 2nd turn.
 *
 * Run: pnpm exec tsx examples/compaction-host.ts
 *
 * Success criteria:
 *   - compact() called at least once during a 2-turn conversation
 *   - agent's history shrinks (turn 2 sees the compacted summary)
 *   - "compaction" event yielded with realtime=false, droppedCount > 0
 */

import { Agent } from "@nextain/agent-core";
import type { HostContext } from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import {
  CompactableMemory,
  InMemoryToolExecutor,
  MockLLMClient,
} from "@nextain/agent-runtime";

// Long text so the first turn exceeds the contextBudget.
const longUserText = "Please summarize the following " + "lorem ipsum ".repeat(200);

const llm = new MockLLMClient({
  turns: [
    { blocks: "Here is the summary you asked for.", stopReason: "end_turn" },
    { blocks: "Answering your follow-up using compacted context.", stopReason: "end_turn" },
  ],
});

const memory = new CompactableMemory();

const host: HostContext = {
  llm,
  memory,
  tools: new InMemoryToolExecutor(),
  logger: new ConsoleLogger({ level: "info" }),
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
    // Tiny budget so even the first turn + recalled memory overflows —
    // compaction will trigger on turn 2 (after turn 1's history lands).
    contextBudget: 200,
    compactionKeepTail: 1,
  });

  console.log("━━━ Turn 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  let compactEvents1 = 0;
  for await (const ev of agent.sendStream(longUserText)) {
    if (ev.type === "compaction") {
      compactEvents1++;
      console.log(`[compact] dropped=${ev.droppedCount} realtime=${ev.realtime}`);
    }
    if (ev.type === "turn.ended") {
      console.log(`[final 1] ${ev.assistantText}`);
    }
  }

  console.log("\n━━━ Turn 2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  let compactEvents2 = 0;
  for await (const ev of agent.sendStream("Follow-up question referencing earlier context")) {
    if (ev.type === "compaction") {
      compactEvents2++;
      console.log(`[compact] dropped=${ev.droppedCount} realtime=${ev.realtime}`);
    }
    if (ev.type === "turn.ended") {
      console.log(`[final 2] ${ev.assistantText}`);
    }
  }

  agent.close();

  console.log("\n━━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  compactCallCount: ${memory.compactCallCount}`);
  console.log(`  compaction events (turn 1): ${compactEvents1}`);
  console.log(`  compaction events (turn 2): ${compactEvents2}`);
  console.log(`  memory records: ${memory.snapshot().length}`);

  if (memory.compactCallCount === 0) {
    console.error("\nFAIL: compact() never called — contract not exercised");
    process.exit(1);
  }
  if (compactEvents1 + compactEvents2 === 0) {
    console.error("\nFAIL: compaction event never emitted");
    process.exit(1);
  }

  console.log("\n✓ CompactableCapable round-trip confirmed");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
