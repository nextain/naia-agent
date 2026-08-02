import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("REQ-023 issue-team layer boundary", () => {
  it("keeps semantic layers free of ingress, UI, SDK, subprocess, Git, and SQLite mechanisms", () => {
    const files = ["../main/domain/issue-team.ts", "../main/domain/issue-team-benchmark.ts", "../main/ports/issue-team.ts", "../main/app/issue-team-worker.ts"];
    const forbidden = ["discord", "naia-shell", "@anthropic-ai", "@earendil-works", "better-sqlite3", "node:child_process", "subagent-codex", "subagent-opencode", "subagent-pi"];
    for (const relative of files) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      const imports = source.split("\n").filter((line) => /^import\s/u.test(line)).join("\n").toLowerCase();
      for (const token of forbidden) expect(imports, `${relative} imports ${token}`).not.toContain(token);
    }
  });
});
