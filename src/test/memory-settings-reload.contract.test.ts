import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error runtime composition is an MJS build helper without declarations.
import { composeAgentRuntimeDeps } from "../../scripts/builds/compose-agent-deps.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("memory settings reload wiring", () => {
  it("ReloadSettings and SetWorkspace await a real memory reconfiguration", () => {
    const entry = readFileSync(resolve(root, "scripts/builds/agent-stdio-entry.mjs"), "utf8");
    const compose = readFileSync(resolve(root, "scripts/builds/compose-agent-deps.mjs"), "utf8");

    expect(entry).toContain("const reloadConfigFrom = async (path, atomicWorkspace = false) =>");
    expect(entry).toContain("await reloadMemory(path)");
    expect(entry).toContain("memoryRetained: memoryResult.retained");
    expect(compose).toContain("settingsStore.loadMemoryConfig(workspacePath)");
    expect(compose).toContain("settingsStore.loadLlmRoles(workspacePath)");
    expect(compose).toContain("memory.reconfigure(async () =>");
    expect(compose).toContain("snapshot.fingerprint === activeMemoryFingerprint");
  });

  it("keeps the live backend on invalid llmRoles and preserves data across a valid swap", async () => {
    const adk = await mkdtemp(join(tmpdir(), "naia-memory-reload-"));
    const settingsDir = join(adk, "naia-settings");
    const configPath = join(settingsDir, "config.json");
    const storePath = join(adk, "memory.json");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ provider: "fake", model: "test" }), "utf8");

    const deps = await composeAgentRuntimeDeps({
      env: {
        ...process.env,
        NAIA_ADK_PATH: adk,
        NAIA_MEMORY_STORE: storePath,
        NAIA_MEMORY_PROJECT: "reload-contract",
        NAIA_AGENT_SKILLS: "off",
        NAIA_AGENT_TRANSCRIPT: "off",
        AGENT_PROVIDER: "fake",
      },
    });
    expect(deps.memory.hasActive()).toBe(true);
    await deps.memory.save("reload-canary", "remembered");

    for (let i = 0; i < 12; i++) {
      await expect(deps.reloadMemory(adk)).resolves.toMatchObject({
        ok: true,
        reloaded: false,
        retained: false,
      });
    }
    expect((await deps.memory.recall("reload-canary")).episodes.length).toBeGreaterThan(0);

    await writeFile(configPath, JSON.stringify({
      provider: "fake",
      model: "test",
      llmRoles: { memory: { provider: "ollama" } },
    }), "utf8");
    const failed = await deps.reloadMemory(adk);
    expect(failed).toMatchObject({ ok: false, reloaded: false, retained: true });
    expect((await deps.memory.recall("reload-canary")).episodes.length).toBeGreaterThan(0);

    const nextAdk = join(adk, "next-workspace");
    await mkdir(join(nextAdk, "naia-settings"), { recursive: true });
    await writeFile(join(nextAdk, "naia-settings", "config.json"), JSON.stringify({ provider: "fake", model: "test" }), "utf8");
    const succeeded = await deps.reloadMemory(nextAdk);
    expect(succeeded).toMatchObject({ ok: true, reloaded: true, retained: false });
    expect((await deps.memory.recall("reload-canary")).episodes.length).toBeGreaterThan(0);
    await deps.memory.close();
  });
});
