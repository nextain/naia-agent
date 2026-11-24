import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(entry).toContain("allowHomeAdkFallback: false");
    expect(entry).toContain("requireConfiguredProvider: discordStandalone");
    expect(compose).toContain("resolveHostAdkPath");
    expect(compose).toContain("allowHomeAdkFallback");
    expect(compose).toContain("settingsStore.loadMemoryConfig(workspacePath)");
    expect(compose).toContain("settingsStore.loadLlmRoles(workspacePath)");
    expect(compose).toContain("memory.reconfigure(async () =>");
    expect(compose).toContain("snapshot.fingerprint === activeMemoryFingerprint");
    expect(compose).toContain("onEmbeddingReindex");
    expect(compose).toContain("store is not empty");
  });

  it("keeps the live backend on invalid llmRoles and preserves data across a valid swap", async () => {
    const adk = await mkdtemp(join(tmpdir(), "naia-memory-reload-"));
    let deps: Awaited<ReturnType<typeof composeAgentRuntimeDeps>> | undefined;
    try {
      const settingsDir = join(adk, "naia-settings");
      const configPath = join(settingsDir, "config.json");
      const storePath = join(adk, "naia-settings", "memory", "store.json");
      await mkdir(settingsDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ provider: "fake", model: "test" }), "utf8");

      deps = await composeAgentRuntimeDeps({
        homeDir: adk,
        env: {
          ...process.env,
          NAIA_ADK_PATH: adk,
          NAIA_AGENT_SKILLS: "off",
          NAIA_AGENT_TRANSCRIPT: "off",
          NAIA_AGENT_MEMORY: "on",
          NAIA_MEMORY_DIR: "",
          NAIA_MEMORY_STORE: "",
          NAIA_MEMORY_PROJECT: "",
          // Empty overrides prevent unrelated OS keychain changes from altering
          // the settings snapshot during this no-configuration-change test.
          NAIA_MEMORY_EMBED_API_KEY: "",
          NAIA_MEMORY_QDRANT_API_KEY: "",
          NAIA_MEMORY_LLM_API_KEY: "",
          NAIA_ANYLLM_API_KEY: "",
          NAIA_KEY: "",
          naiaKey: "",
          AGENT_PROVIDER: "fake",
        },
      });
      expect(deps.settingsStore.loadMemoryConfig(adk)).toMatchObject({
        adapter: "local",
        embedding: { provider: "none" },
        llm: { provider: "none" },
      });
      expect(deps.settingsResolveSecret("NAIA_ANYLLM_API_KEY")).toBe("");
      expect(deps.memory.hasActive()).toBe(true);
      await deps.memory.save("reload-canary", "remembered", { durable: true });

      for (let i = 0; i < 12; i++) {
        await expect(deps.reloadMemory(adk)).resolves.toMatchObject({
          ok: true,
          reloaded: false,
          retained: false,
        });
      }
      expect(readFileSync(storePath, "utf8")).toContain("reload-canary");

      await writeFile(configPath, JSON.stringify({
        provider: "fake",
        model: "test",
        llmRoles: { memory: { provider: "ollama" } },
      }), "utf8");
      const failed = await deps.reloadMemory(adk);
      expect(failed).toMatchObject({ ok: false, reloaded: false, retained: true });
      await deps.memory.save("retained-canary", "still-active", { durable: true });
      expect(readFileSync(storePath, "utf8")).toContain("retained-canary");

      const nextAdk = join(adk, "next-workspace");
      const nextStorePath = join(nextAdk, "naia-settings", "memory", "store.json");
      await mkdir(join(nextAdk, "naia-settings"), { recursive: true });
      await writeFile(join(nextAdk, "naia-settings", "config.json"), JSON.stringify({ provider: "fake", model: "test" }), "utf8");
      const succeeded = await deps.reloadMemory(nextAdk);
      expect(succeeded).toMatchObject({ ok: true, reloaded: true, retained: false });
      expect(readFileSync(storePath, "utf8")).toContain("reload-canary");
      await deps.memory.save("next-workspace-canary", "isolated", { durable: true });
      expect(readFileSync(nextStorePath, "utf8")).toContain("next-workspace-canary");
      expect(readFileSync(nextStorePath, "utf8")).not.toContain("reload-canary");
      expect(readFileSync(storePath, "utf8")).not.toContain("next-workspace-canary");
    } finally {
      for (const cleanup of [...(deps?.cleanupFns ?? [])].reverse()) {
        try { cleanup(); } catch { /* preserve the test result while releasing other resources */ }
      }
      try {
        await deps?.memory?.close();
      } finally {
        await rm(adk, { recursive: true, force: true });
      }
    }
  }, 15_000);
});
