import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAdkExtension } from "../adk-extension-loader.js";

describe("loadAdkExtension", () => {
  const tmpDir = path.join(os.tmpdir(), `naia-adk-ext-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty extension when no files exist", async () => {
    const ext = await loadAdkExtension(tmpDir);
    expect(ext.hooks).toEqual([]);
    expect(ext.prompts).toEqual([]);
  });

  it("loads prompt.md as ADK prompt fragment", async () => {
    fs.writeFileSync(path.join(tmpDir, "prompt.md"), "This is a domain prompt.", "utf-8");
    const ext = await loadAdkExtension(tmpDir);
    expect(ext.prompts).toHaveLength(1);
    expect(ext.prompts[0]!.source).toBe("adk");
    expect(ext.prompts[0]!.section).toBe("domain");
    expect(ext.prompts[0]!.content).toBe("This is a domain prompt.");
  });

  it("ignores empty prompt.md", async () => {
    fs.writeFileSync(path.join(tmpDir, "prompt.md"), "   \n\n  ", "utf-8");
    const ext = await loadAdkExtension(tmpDir);
    expect(ext.prompts).toHaveLength(0);
  });

  it("loads hooks.json with hook entries", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "hooks.json"),
      JSON.stringify({
        hooks: [
          { event: "turn-start", handler: "echo hello", priority: 100 },
          { event: "turn-end", handler: "echo done" },
        ],
      }, null, 2),
      "utf-8",
    );
    const ext = await loadAdkExtension(tmpDir);
    expect(ext.hooks).toHaveLength(2);
    expect(ext.hooks[0]!.event).toBe("turn-start");
    expect(ext.hooks[0]!.source).toBe("adk");
    expect(ext.hooks[0]!.priority).toBe(100);
    expect(ext.hooks[1]!.event).toBe("turn-end");
  });

  it("handles malformed hooks.json gracefully", async () => {
    fs.writeFileSync(path.join(tmpDir, "hooks.json"), "{bad json", "utf-8");
    const ext = await loadAdkExtension(tmpDir);
    expect(ext.hooks).toEqual([]);
  });

  it("loads both hooks and prompts together", async () => {
    fs.writeFileSync(path.join(tmpDir, "prompt.md"), "Domain rules here.", "utf-8");
    fs.writeFileSync(
      path.join(tmpDir, "hooks.json"),
      JSON.stringify({ hooks: [{ event: "error", handler: "notify-admin" }] }),
      "utf-8",
    );
    const ext = await loadAdkExtension(tmpDir);
    expect(ext.hooks).toHaveLength(1);
    expect(ext.prompts).toHaveLength(1);
  });
});
