import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("UC-ORCH-002 manager layer boundary", () => {
  it("keeps domain, port, and app free of transport and provider SDK imports", () => {
    const files = [
      "../main/domain/multi-issue-session.ts",
      "../main/ports/multi-issue-session.ts",
      "../main/app/multi-issue-session-manager.ts",
    ];
    const forbidden = ["discord", "naia-shell", "@anthropic-ai", "@earendil-works", "openai-codex", "subagent-codex"];
    for (const relative of files) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      const imports = source.split("\n").filter((line) => /^import\s/u.test(line)).join("\n").toLowerCase();
      for (const token of forbidden) expect(imports, `${relative} imports ${token}`).not.toContain(token);
    }
  });
});
