/**
 * skill-loader-host — verifies FileSkillLoader parses naia-adk
 * SKILL.md front-matter correctly and the host can wire an invoker.
 *
 * Creates a tmp workspace with two skills, runs list/get/invoke.
 */

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSkillLoader } from "@nextain/agent-runtime";
import type { SkillDescriptor, SkillOutput } from "@nextain/agent-runtime";

const SKILL_A = `---
name: greet
description: Say hello to someone.
version: 1.0.0
tier: T0
tags: [social, demo]
input_schema:
  type: object
  required: [name]
  properties:
    name:
      type: string
---

# greet

Polite hello.
`;

const SKILL_B = `---
name: danger
description: Pretends to be a dangerous command.
version: 0.2.1
tier: T3
author: test-fixture
---

# danger

Requires approval.
`;

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "naia-skill-loader-"));
  try {
    const skills = join(root, ".agents", "skills");
    mkdirSync(join(skills, "greet"), { recursive: true });
    mkdirSync(join(skills, "danger"), { recursive: true });
    writeFileSync(join(skills, "greet", "SKILL.md"), SKILL_A);
    writeFileSync(join(skills, "danger", "SKILL.md"), SKILL_B);

    // Invoker: just echoes the args.
    const invoker = async (desc: SkillDescriptor, input: { args: unknown }): Promise<SkillOutput> => ({
      content: `invoked ${desc.name} tier=${desc.tier} args=${JSON.stringify(input.args)}`,
    });

    const loader = new FileSkillLoader({ workspaceRoot: root, invoker });

    const list = await loader.list();
    console.log("━━━ list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    for (const s of list) {
      console.log(
        `  ${s.name}@${s.version} tier=${s.tier} tags=${JSON.stringify(s.tags ?? [])} description="${s.description}"`,
      );
    }

    const greet = await loader.get("greet");
    console.log("\n━━━ greet descriptor ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  inputSchema: ${JSON.stringify(greet?.inputSchema)}`);

    const result = await loader.invoke("greet", { args: { name: "world" } });
    console.log("\n━━━ invoke(greet) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  ${result.content}`);

    const missing = await loader.invoke("nope", { args: {} });
    console.log("\n━━━ invoke(nope) → expected isError ━━━━━━━━━━━━━━━━━━━");
    console.log(`  isError=${missing.isError}`);

    // Assertions
    if (list.length !== 2) {
      console.error(`FAIL: expected 2 skills, got ${list.length}`);
      process.exit(1);
    }
    if (greet?.tier !== "T0") {
      console.error(`FAIL: expected greet.tier T0, got ${greet?.tier}`);
      process.exit(1);
    }
    const danger = await loader.get("danger");
    if (danger?.tier !== "T3" || danger.author !== "test-fixture") {
      console.error(`FAIL: danger descriptor mismatch`);
      process.exit(1);
    }
    const schemaObj = greet?.inputSchema as { type?: string; properties?: { name?: { type?: string } } };
    if (schemaObj?.type !== "object" || schemaObj?.properties?.name?.type !== "string") {
      console.error(`FAIL: nested inputSchema not parsed`);
      process.exit(1);
    }
    if (!result.content.includes("world")) {
      console.error(`FAIL: invoker didn't receive args`);
      process.exit(1);
    }
    if (missing.isError !== true) {
      console.error(`FAIL: missing skill should return isError=true`);
      process.exit(1);
    }

    console.log("\n✓ FileSkillLoader smoke passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
