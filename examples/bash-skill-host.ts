/**
 * bash-skill-host — example showing the bash skill in action with a mock LLM
 * scripted to call the `bash` tool.
 *
 * Run:
 *   pnpm exec tsx examples/bash-skill-host.ts
 *
 * What it exercises:
 *   - createHost({ enableBash: true }) registers the bash skill
 *   - MockLLMClient scripts a tool_use block targeting `bash`
 *   - DANGEROUS_COMMANDS regex blocks unsafe commands (negative case)
 *   - Real shell execution for safe commands
 */

import { Agent } from "@nextain/agent-core";
import {
  createHost,
  MockLLMClient,
  type MockScript,
} from "@nextain/agent-runtime";

const safeScript: MockScript = {
  turns: [
    {
      blocks: [
        { type: "text", text: "Let me list TypeScript files in the bin directory." },
        {
          type: "tool_use",
          id: "call-bash-1",
          name: "bash",
          input: { command: "ls bin/*.ts 2>/dev/null | head -3" },
        },
      ],
      stopReason: "tool_use",
    },
    {
      blocks: "I found the bin entry — bin/naia-agent.ts.",
      stopReason: "end_turn",
    },
  ],
};

const dangerousScript: MockScript = {
  turns: [
    {
      blocks: [
        { type: "text", text: "I'll attempt a dangerous command." },
        {
          type: "tool_use",
          id: "call-bash-evil",
          name: "bash",
          input: { command: "rm -rf /" },
        },
      ],
      stopReason: "tool_use",
    },
    {
      blocks: "The dangerous command was blocked, as expected.",
      stopReason: "end_turn",
    },
  ],
};

async function runScenario(name: string, script: MockScript): Promise<void> {
  console.log(`\n━━━ ${name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  const host = createHost({
    logLevel: "warn",
    enableBash: true,
    llm: new MockLLMClient(script),
  });
  const agent = new Agent({
    host,
    systemPrompt: "Test agent.",
    tierForTool: (n) => (n === "bash" ? "T1" : "T0"),
  });
  for await (const ev of agent.sendStream("do it")) {
    if (ev.type === "tool.started") {
      console.log(`[tool ▶] ${ev.invocation.name}(${JSON.stringify(ev.invocation.input)})`);
    } else if (ev.type === "tool.ended") {
      const content = ev.result.content;
      const truncated = content.length > 200 ? content.slice(0, 200) + "…" : content;
      console.log(`[tool ◀] ${truncated}`);
    } else if (ev.type === "turn.ended") {
      console.log(`[final] ${ev.assistantText}`);
    }
  }
  agent.close();
}

async function main(): Promise<void> {
  await runScenario("safe-bash (ls)", safeScript);
  await runScenario("dangerous-bash (rm -rf /) — should be BLOCKED", dangerousScript);
  console.log("\n✓ bash-skill-host smoke passed");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
