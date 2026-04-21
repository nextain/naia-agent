/**
 * skill-tool-host — Agent calls a SKILL.md-defined skill via the LLM's
 * tool-use mechanism. Verifies SkillToolExecutor bridges loader → executor
 * correctly so that skills are first-class tools for the agent.
 */

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@nextain/agent-core";
import type { HostContext } from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import {
  FileSkillLoader,
  InMemoryMemory,
  MockLLMClient,
  SkillToolExecutor,
} from "@nextain/agent-runtime";

const SKILL_ECHO = `---
name: echo-skill
description: Echoes the input message with a prefix.
version: 1.0.0
tier: T0
input_schema:
  type: object
  required: [message]
  properties:
    message:
      type: string
---

# echo-skill

Returns "ECHO via SKILL: {message}".
`;

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "naia-skill-tool-"));
  try {
    mkdirSync(join(root, ".agents", "skills", "echo-skill"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "echo-skill", "SKILL.md"), SKILL_ECHO);

    const loader = new FileSkillLoader({
      workspaceRoot: root,
      invoker: async (desc, input) => {
        const { message } = input.args as { message: string };
        return { content: `ECHO via SKILL (${desc.name}): ${message}` };
      },
    });

    const tools = new SkillToolExecutor({ loader });

    const llm = new MockLLMClient({
      turns: [
        {
          blocks: [
            {
              type: "tool_use",
              id: "call_1",
              name: "echo-skill",
              input: { message: "hello-from-skill-loader" },
            },
          ],
          stopReason: "tool_use",
        },
        { blocks: "The skill ran successfully.", stopReason: "end_turn" },
      ],
    });

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

    const agent = new Agent({ host });
    let sawToolStart = false;
    let sawToolEndOk = false;
    let finalText = "";
    for await (const ev of agent.sendStream("Run the echo-skill please.")) {
      if (ev.type === "tool.started" && ev.invocation.name === "echo-skill") {
        sawToolStart = true;
      }
      if (ev.type === "tool.ended" && ev.invocation.name === "echo-skill") {
        sawToolEndOk = !ev.result.isError && ev.result.content.includes("hello-from-skill-loader");
        console.log(`[tool end] content=${ev.result.content}`);
      }
      if (ev.type === "turn.ended") finalText = ev.assistantText;
    }
    agent.close();

    console.log(`\n  final: ${finalText}`);
    console.log(`  sawToolStart: ${sawToolStart}`);
    console.log(`  sawToolEndOk: ${sawToolEndOk}`);
    if (!sawToolStart || !sawToolEndOk) {
      console.error("FAIL: tool lifecycle not observed correctly");
      process.exit(1);
    }
    console.log("\n✓ SkillToolExecutor bridge passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
