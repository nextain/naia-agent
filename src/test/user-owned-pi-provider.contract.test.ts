import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUserOwnedPiModelsConfig, ensureUserOwnedPiConfig, type UserOwnedPiProvider,
} from "../main/adapters/user-owned-pi-provider.js";
import { makePiSubAgent, type SpawnFn } from "../main/adapters/subagent-pi.js";

const local: UserOwnedPiProvider = { id: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1/",
  models: [{ id: "naia-0.9-coding-24g", name: "Qwen3.6 27B local", contextWindow: 65_536, maxTokens: 4_096 }] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("user-owned Pi provider", () => {
  it("writes a zero-catalog-price loopback provider without inherited credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-local-pi-")); dirs.push(dir);
    ensureUserOwnedPiConfig(local, dir);
    const text = readFileSync(join(dir, "models.json"), "utf8");
    expect(JSON.parse(text)).toEqual(buildUserOwnedPiModelsConfig(local));
    expect(text).toContain('"contextWindow": 65536');
    expect(text).toContain('"input": 0');
    expect(text).not.toMatch(/NAIA_API_KEY|OPENAI_API_KEY/u);
  });

  it("rejects remote, credential-bearing, duplicate, and reserved provider declarations", () => {
    expect(() => buildUserOwnedPiModelsConfig({ ...local, baseUrl: "https://example.com/v1" })).toThrow(/loopback/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, baseUrl: "http://user:pass@127.0.0.1:8000/v1" })).toThrow(/loopback/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, id: "naia" })).toThrow(/local- prefix/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, id: "openai" })).toThrow(/local- prefix/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, models: [{ ...local.models[0]!, id: "bad\nmodel" }] })).toThrow(/limits/u);
    expect(() => buildUserOwnedPiModelsConfig({ ...local, models: [local.models[0]!, local.models[0]!] })).toThrow(/unique/u);
  });

  it("spawns the declared model with an isolated Pi config and no unrelated secrets", () => {
    let captured: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const spawnFn: SpawnFn = (_command, args, options) => { captured = { args, env: options.env };
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess; };
    const dir = mkdtempSync(join(tmpdir(), "naia-local-pi-")); dirs.push(dir);
    makePiSubAgent({ provider: "local-vllm", model: "naia-0.9-coding-24g", userOwnedProvider: local,
      piConfigDir: dir, resolveBin: () => ({ command: "pi", prefixArgs: [] }), spawnFn,
      env: { PATH: "bin", OPENAI_API_KEY: "must-not-leak", NAIA_API_KEY: "must-not-leak" } })
      .spawn({ prompt: "inspect", workdir: ".", model: "naia-0.9-coding-24g", filesystemAccess: "read_only" });
    expect(captured?.args).toContain("local-vllm");
    expect(captured?.args).toContain("naia-0.9-coding-24g");
    expect(captured?.args).toContain("read,grep,find,ls");
    expect(captured?.env).toMatchObject({ PATH: "bin", PI_CODING_AGENT_DIR: dir });
    expect(captured?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(captured?.env?.NAIA_API_KEY).toBeUndefined();
  });

  it("rejects a remote live-benchmark endpoint before catalog or model I/O", () => {
    const run = spawnSync(process.execPath, [join(process.cwd(), "benchmark/run-user-owned-three-layer-live.mjs")], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env,
        NAIA_LOCAL_OPENAI_BASE_URL: "https://example.com/v1", NAIA_LOCAL_RUNTIME_CONTAINER: "must-not-inspect" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("must be credential-free loopback HTTP");
    expect(run.stderr).not.toContain("local model catalog failed");
  });

  it("preserves an existing live result before endpoint or model I/O", () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-local-live-output-")); dirs.push(dir);
    const output = join(dir, "canonical.json"); writeFileSync(output, "preserve-me");
    const run = spawnSync(process.execPath,
      [join(process.cwd(), "benchmark/run-user-owned-three-layer-live.mjs"), "--output", output], {
        encoding: "utf8", timeout: 10_000, env: { ...process.env,
          NAIA_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:1/v1", NAIA_LOCAL_RUNTIME_CONTAINER: "must-not-inspect" },
      });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("live benchmark output path already exists");
    expect(run.stderr).not.toContain("local model catalog failed");
    expect(readFileSync(output, "utf8")).toBe("preserve-me");
  });
});
