import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * #610: model-facing discord/cron tools must not be registered.
 */
describe("#610 discord/cron model tools absent", () => {
  const root = join(import.meta.dirname, "..");
  const gone = [
    "main/adapters/discord-outbound-skill.ts",
    "main/adapters/scheduled-task-skill.ts",
    "main/adapters/cron-skills.ts",
    "main/adapters/scheduled-task-runtime.ts",
  ];

  it.each(gone)("%s is deleted", (rel) => {
    expect(existsSync(join(root, rel))).toBe(false);
  });

  it("stdio entry does not register discord_send or scheduled_report", () => {
    const entry = readFileSync(
      join(root, "..", "scripts/builds/agent-stdio-entry.mjs"),
      "utf8",
    );
    expect(entry.includes('skillsLabel += " + discord_send"')).toBe(false);
    expect(entry.includes('skillsLabel += " + scheduled_report"')).toBe(false);
    expect(entry.includes("makeDiscordOutboundExecutor")).toBe(false);
    expect(entry.includes("makeScheduledTaskExecutor")).toBe(false);
  });
});
