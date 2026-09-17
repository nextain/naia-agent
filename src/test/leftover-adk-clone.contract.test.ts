import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error runtime composition is an MJS build helper without declarations.
import { composeAgentRuntimeDeps, resolveHostAdkPath } from "../../scripts/builds/compose-agent-deps.mjs";

const LEFTOVER_MARKER = "LEFTOVER-CLONE-STORE";
const SELECTED_MARKER = "SELECTED-ADK-STORE";

function leftoverHomeLayout(root: string) {
  const homeDir = join(root, "home");
  const leftover = join(homeDir, "naia-adk");
  const leftoverStore = join(leftover, "naia-settings", "memory", "store.json");
  mkdirSync(join(leftover, "naia-settings", "memory"), { recursive: true });
  mkdirSync(join(homeDir, ".naia-agent"), { recursive: true });
  writeFileSync(leftoverStore, JSON.stringify({ version: 1, facts: [{ id: "leftover", content: LEFTOVER_MARKER }] }));
  writeFileSync(join(homeDir, ".naia-agent", "config.json"), JSON.stringify({ adkPath: leftover }, null, 2));
  return { homeDir, leftover, leftoverStore };
}

describe("leftover ~/naia-adk clone is not a product store", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("resolveHostAdkPath: NAIA_ADK_PATH wins over leftover clone and CLI global pin", () => {
    const leftover = "C:\\Users\\LukeYang\\naia-adk";
    const selected = "D:\\alpha-adk";
    expect(resolveHostAdkPath({
      envAdkPath: selected,
      globalAdkPath: leftover,
      defaultAdkPath: leftover,
      allowHomeAdkFallback: true,
    })).toBe(selected);
    expect(resolveHostAdkPath({
      envAdkPath: `  ${selected}  `,
      globalAdkPath: leftover,
      defaultAdkPath: leftover,
      allowHomeAdkFallback: false,
    })).toBe(selected);
    expect(resolveHostAdkPath({
      envAdkPath: "",
      globalAdkPath: leftover,
      defaultAdkPath: leftover,
      allowHomeAdkFallback: false,
    })).toBe("");
    expect(resolveHostAdkPath({
      envAdkPath: leftover,
      globalAdkPath: selected,
      defaultAdkPath: selected,
      allowHomeAdkFallback: false,
    })).toBe(leftover);
  });

  it("does not use a second clone path when NAIA_ADK_PATH is the selected ADK", async () => {
    root = await mkdtemp(join(tmpdir(), "naia-leftover-clone-"));
    const { homeDir, leftover, leftoverStore } = leftoverHomeLayout(root);
    const selected = join(root, "alpha-adk");
    const selectedStore = join(selected, "naia-settings", "memory", "store.json");
    await mkdir(join(selected, "naia-settings"), { recursive: true });
    await writeFile(join(selected, "naia-settings", "config.json"), JSON.stringify({ provider: "fake", model: "test" }));

    const deps = await composeAgentRuntimeDeps({
      homeDir,
      allowHomeAdkFallback: false,
      env: {
        ...process.env,
        NAIA_ADK_PATH: selected,
        AGENT_PROVIDER: "fake",
        NAIA_AGENT_SKILLS: "off",
        NAIA_AGENT_TRANSCRIPT: "off",
      },
    });
    expect(deps.adkPath).toBe(selected);
    expect(deps.adkPath).not.toBe(leftover);
    if (deps.memory?.hasActive()) {
      await deps.memory.save(SELECTED_MARKER, "bound-to-selected", { durable: true });
      await deps.memory.close();
      expect(readFileSync(selectedStore, "utf8")).toContain(SELECTED_MARKER);
    } else if (deps.memory?.close) {
      await deps.memory.close();
    }
    expect(readFileSync(leftoverStore, "utf8")).toContain(LEFTOVER_MARKER);
    expect(readFileSync(leftoverStore, "utf8")).not.toContain(SELECTED_MARKER);
  });

  it("gRPC host does not boot leftover clone memory, then SetWorkspace binds the selected ADK", async () => {
    root = await mkdtemp(join(tmpdir(), "naia-leftover-setws-"));
    const { homeDir, leftover, leftoverStore } = leftoverHomeLayout(root);
    const selected = join(root, "alpha-adk");
    const selectedStore = join(selected, "naia-settings", "memory", "store.json");
    await mkdir(join(selected, "naia-settings"), { recursive: true });
    await writeFile(join(selected, "naia-settings", "config.json"), JSON.stringify({ provider: "fake", model: "test" }));

    const deps = await composeAgentRuntimeDeps({
      homeDir,
      allowHomeAdkFallback: false,
      env: {
        ...process.env,
        NAIA_ADK_PATH: "",
        AGENT_PROVIDER: "fake",
        NAIA_AGENT_SKILLS: "off",
        NAIA_AGENT_TRANSCRIPT: "off",
      },
    });
    expect(deps.adkPath).toBe("");
    expect(deps.memory?.hasActive?.() ?? false).toBe(false);
    expect(readFileSync(leftoverStore, "utf8")).toContain(LEFTOVER_MARKER);

    const rebound = await deps.reloadMemory(selected);
    if (rebound.ok) {
      expect(rebound).toMatchObject({ ok: true, reloaded: true, retained: false });
      await deps.memory.save(SELECTED_MARKER, "set-workspace-bound", { durable: true });
      expect(readFileSync(selectedStore, "utf8")).toContain(SELECTED_MARKER);
    }
    if (deps.memory?.close) await deps.memory.close();

    expect(readFileSync(leftoverStore, "utf8")).toContain(LEFTOVER_MARKER);
    expect(readFileSync(leftoverStore, "utf8")).not.toContain(SELECTED_MARKER);
    expect(leftover).not.toBe(selected);
  });
});
