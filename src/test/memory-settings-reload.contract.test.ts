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
    expect(entry).toContain("const memoResult = prepareMemoWorkspace");
    expect(entry).toContain("memoResult.commit?.();");
    expect(entry).toContain("memoError: memoResult.ok ?");
    expect(entry).toContain("await reloadMemory(path)");
    expect(entry).toContain("memoryRetained: memoryResult.retained");
    expect(compose).toContain("settingsStore.loadMemoryConfig(workspacePath)");
    expect(compose).toContain("settingsStore.loadLlmRoles(workspacePath)");
    expect(compose).toContain("memory.reconfigure(async () =>");
    expect(compose).toContain("snapshot.fingerprint === activeMemoryFingerprint");
    expect(compose).toContain("prepareMemoWorkspace = (workspacePath) =>");
    expect(compose).toContain("activeBuiltin = nextBuiltin");
  });

  it("keeps the live backend on invalid llmRoles and preserves data across a valid swap", async () => {
    const adk = await mkdtemp(join(tmpdir(), "naia-memory-reload-"));
    const settingsDir = join(adk, "naia-settings");
    const configPath = join(settingsDir, "config.json");
    const storePath = join(adk, "naia-settings", "memory", "store.json");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ provider: "fake", model: "test" }), "utf8");

    const deps = await composeAgentRuntimeDeps({
      env: {
        ...process.env,
        NAIA_ADK_PATH: adk,
        NAIA_AGENT_SKILLS: "off",
        NAIA_AGENT_TRANSCRIPT: "off",
        AGENT_PROVIDER: "fake",
      },
    });
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
    await deps.memory.close();
  });

  it("scopes the default file memo store to the selected ADK across A/B/A restarts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "naia-memo-scope-"));
    const adkA = join(parent, "adk-A");
    const adkB = join(parent, "adk-B");
    await mkdir(join(adkA, "naia-settings"), { recursive: true });
    await mkdir(join(adkB, "naia-settings"), { recursive: true });

    const envFor = (adk: string, memoPath = "") => ({
      ...process.env,
      NAIA_ADK_PATH: adk,
      NAIA_AGENT_MEMORY: "off",
      NAIA_AGENT_TRANSCRIPT: "off",
      NAIA_KNOWLEDGE: "off",
      AGENT_PROVIDER: "fake",
      NAIA_MEMO_PATH: memoPath,
    });
    const close = async (deps: { cleanupFns?: Array<() => unknown>; memory?: { close?: () => Promise<unknown> } }) => {
      await deps.memory?.close?.();
      for (const cleanup of deps.cleanupFns ?? []) await cleanup();
    };

    const firstA = await composeAgentRuntimeDeps({ env: envFor(adkA) });
    expect(firstA.skillsLabel).toContain(join(adkA, "naia-settings", "memos.json"));
    await expect(firstA.toolExecutor.execute({ id: "save-a", name: "memo_save", args: { title: "A-only", content: "from A" } }, {})).resolves.toMatchObject({ output: "저장됨: A-only" });
    // Rebind the same long-lived executor before closing it. A prepared
    // candidate must not leak into calls until the workspace transaction
    // commits, and the committed B→A return must expose only A's file.
    const pendingB = firstA.prepareMemoWorkspace(adkB);
    expect(pendingB).toMatchObject({ ok: true, changed: true, path: join(adkB, "naia-settings", "memos.json") });
    await expect(firstA.toolExecutor.execute({ id: "still-a", name: "memo_get", args: { title: "A-only" } }, {})).resolves.toMatchObject({ output: "from A" });
    pendingB.commit();
    await expect(firstA.toolExecutor.execute({ id: "same-b", name: "memo_get", args: { title: "A-only" } }, {})).resolves.toMatchObject({ output: "(없음)" });
    await expect(firstA.toolExecutor.execute({ id: "save-b", name: "memo_save", args: { title: "B-only", content: "from B" } }, {})).resolves.toMatchObject({ output: "저장됨: B-only" });

    const pendingA = firstA.prepareMemoWorkspace(adkA);
    expect(pendingA).toMatchObject({ ok: true, changed: true, path: join(adkA, "naia-settings", "memos.json") });
    pendingA.commit();
    await expect(firstA.toolExecutor.execute({ id: "same-a", name: "memo_get", args: { title: "A-only" } }, {})).resolves.toMatchObject({ output: "from A" });
    await expect(firstA.toolExecutor.execute({ id: "same-a-missing-b", name: "memo_get", args: { title: "B-only" } }, {})).resolves.toMatchObject({ output: "(없음)" });
    await close(firstA);

    const inB = await composeAgentRuntimeDeps({ env: envFor(adkB) });
    expect(inB.skillsLabel).toContain(join(adkB, "naia-settings", "memos.json"));
    await expect(inB.toolExecutor.execute({ id: "get-b", name: "memo_get", args: { title: "A-only" } }, {})).resolves.toMatchObject({ output: "(없음)" });
    await expect(inB.toolExecutor.execute({ id: "get-b-only", name: "memo_get", args: { title: "B-only" } }, {})).resolves.toMatchObject({ output: "from B" });
    await close(inB);

    const restoredA = await composeAgentRuntimeDeps({ env: envFor(adkA) });
    await expect(restoredA.toolExecutor.execute({ id: "get-a", name: "memo_get", args: { title: "A-only" } }, {})).resolves.toMatchObject({ output: "from A" });
    await expect(restoredA.toolExecutor.execute({ id: "get-a-missing-b", name: "memo_get", args: { title: "B-only" } }, {})).resolves.toMatchObject({ output: "(없음)" });
    await close(restoredA);

    expect(readFileSync(join(adkA, "naia-settings", "memos.json"), "utf8")).toContain("A-only");
    expect(readFileSync(join(adkB, "naia-settings", "memos.json"), "utf8")).toContain("B-only");
    expect(readFileSync(join(adkB, "naia-settings", "memos.json"), "utf8")).not.toContain("A-only");

    const explicit = join(parent, "explicit", "memos.json");
    const override = await composeAgentRuntimeDeps({ env: envFor(adkB, explicit) });
    expect(override.skillsLabel).toContain(explicit);
    expect(override.prepareMemoWorkspace(adkA)).toMatchObject({ ok: true, changed: false, path: explicit });
    await expect(override.toolExecutor.execute({ id: "save-explicit", name: "memo_save", args: { title: "explicit", content: "override" } }, {})).resolves.toMatchObject({ output: "저장됨: explicit" });
    await close(override);
    expect(readFileSync(explicit, "utf8")).toContain("explicit");
  });
});
