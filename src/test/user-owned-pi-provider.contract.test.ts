import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUserOwnedCodexModelCatalog,
  buildUserOwnedPiModelsConfig,
  ensureUserOwnedPiConfig,
  isBuiltInLocalProvider,
  resolveLocalEngineBaseUrl,
  type UserOwnedPiProvider,
} from "../main/adapters/user-owned-pi-provider.js";
import { makeCodexSubAgent } from "../main/adapters/subagent-codex.js";
import type { SpawnFn } from "../main/adapters/subprocess-session.js";

const local: UserOwnedPiProvider = {
  id: "local-vllm",
  baseUrl: "http://127.0.0.1:8000/v1/",
  models: [{ id: "naia-0.9-coding-24g", name: "Qwen3.6 27B local", contextWindow: 65_536, maxTokens: 4_096 }],
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("user-owned and built-in local providers on Codex loopback bridge", () => {
  it("writes a zero-catalog-price loopback provider without inherited credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-local-pi-")); dirs.push(dir);
    ensureUserOwnedPiConfig(local, dir);
    const text = readFileSync(join(dir, "models.json"), "utf8");
    expect(JSON.parse(text)).toEqual(buildUserOwnedPiModelsConfig(local));
    expect(text).toContain('"contextWindow": 65536');
    expect(text).toContain('"input": 0');
    expect(text).not.toMatch(/NAIA_API_KEY|OPENAI_API_KEY/u);

    const catalog = buildUserOwnedCodexModelCatalog(local);
    expect(catalog.models[0]).toMatchObject({
      slug: "naia-0.9-coding-24g",
      context_window: 65_536,
      use_responses_lite: false,
      tool_mode: "direct",
      experimental_supported_tools: [],
      supports_search_tool: false,
    });
  });

  it("rejects remote, credential-bearing, duplicate, and reserved provider declarations", () => {
    expect(() => buildUserOwnedPiModelsConfig({ ...local, baseUrl: "https://example.com/v1" })).toThrow(/loopback/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, baseUrl: "http://user:pass@127.0.0.1:8000/v1" })).toThrow(/loopback/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, id: "naia" })).toThrow(/local- prefix/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, id: "openai" })).toThrow(/local- prefix/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, models: [{ ...local.models[0]!, id: "bad\nmodel" }] })).toThrow(/limits/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, models: [local.models[0]!, local.models[0]!] })).toThrow(/unique/u);
  });

  it("resolves built-in local engines (local, ollama, vllm, lmstudio) to loopback base URLs", () => {
    expect(isBuiltInLocalProvider("ollama")).toBe(true);
    expect(isBuiltInLocalProvider("vllm")).toBe(true);
    expect(isBuiltInLocalProvider("lmstudio")).toBe(true);
    expect(isBuiltInLocalProvider("local")).toBe(true);
    expect(isBuiltInLocalProvider("openai")).toBe(false);
    expect(resolveLocalEngineBaseUrl("ollama")).toBe("http://127.0.0.1:11434/v1");
    expect(resolveLocalEngineBaseUrl("vllm")).toBe("http://127.0.0.1:8000/v1");
    expect(resolveLocalEngineBaseUrl("lmstudio")).toBe("http://127.0.0.1:1234/v1");
  });

  it("spawns the declared user-owned model with Codex [model_providers.local-vllm] and no unrelated secrets", async () => {
    let captured: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const spawnFn: SpawnFn = (_command, args, options) => {
      captured = { args, env: options.env };
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
    };
    const dir = mkdtempSync(join(tmpdir(), "naia-local-pi-")); dirs.push(dir);
    const session = makeCodexSubAgent({
      provider: "local-vllm",
      model: "naia-0.9-coding-24g",
      userOwnedProvider: local,
      piConfigDir: dir,
      resolveBin: () => ({ command: "codex", prefixArgs: [] }),
      spawnFn,
      env: { PATH: "bin", OPENAI_API_KEY: "must-not-leak", NAIA_API_KEY: "must-not-leak" },
    }).spawn({ prompt: "inspect", workdir: ".", model: "naia-0.9-coding-24g", filesystemAccess: "read_only" });
    await session.cancel("done");
    expect(captured?.args).toEqual(expect.arrayContaining([
      "-c", 'model_provider="local-vllm"',
      "-c", 'model_providers.local-vllm.wire_api="responses"',
      "--model", "naia-0.9-coding-24g",
      "--sandbox", "read-only",
    ]));
    expect(captured?.env?.NAIA_BRIDGE_TOKEN).toBeUndefined();
    expect(captured?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(captured?.env?.NAIA_API_KEY).toBeUndefined();
  });
});
