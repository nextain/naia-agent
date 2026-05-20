// Slice 1c — env + JSON config loader unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ~/.naia-agent/config.json이 존재하면 NAIA_ADK_PATH 테스트가 candidate #4에서
// 가로채져 실패함. CI에는 해당 파일이 없으므로 정상 실행, 로컬은 skipIf로 skip.
const naiaHomeConfig = join(homedir(), ".naia-agent", "config.json");
const noHomeConfig = !existsSync(naiaHomeConfig);
import {
  parseEnv,
  flattenConfig,
  loadEnvAndConfig,
} from "../utils/env-loader.js";

describe("parseEnv", () => {
  it("parses basic KEY=value", () => {
    expect(parseEnv("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("strips double quotes", () => {
    expect(parseEnv('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  it("strips single quotes", () => {
    expect(parseEnv("FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  it("ignores comments and blank lines", () => {
    const input = `
# comment
FOO=bar

# another
BAZ=qux
`;
    expect(parseEnv(input)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips export prefix", () => {
    expect(parseEnv("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("handles = inside value", () => {
    expect(parseEnv("URL=https://x.com/a=b")).toEqual({ URL: "https://x.com/a=b" });
  });

  it("ignores malformed lines", () => {
    expect(parseEnv("just-text-no-equals")).toEqual({});
    expect(parseEnv("=no-key")).toEqual({});
  });
});

describe("flattenConfig", () => {
  it("flattens top-level keys to UPPERCASE", () => {
    expect(flattenConfig({ foo: "bar", baz: "qux" })).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("flattens nested objects with _ (camelCase → SNAKE_CASE)", () => {
    expect(flattenConfig({ anthropic: { apiKey: "x", model: "y" } })).toEqual({
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_MODEL: "y",
    });
  });

  it("converts kebab-case keys", () => {
    expect(flattenConfig({ "max-tokens": 100 })).toEqual({ MAX_TOKENS: "100" });
  });

  it("stringifies non-string scalars", () => {
    expect(flattenConfig({ port: 3000, debug: true })).toEqual({
      PORT: "3000",
      DEBUG: "true",
    });
  });

  it("serializes arrays as JSON", () => {
    expect(flattenConfig({ tags: ["a", "b"] })).toEqual({
      TAGS: '["a","b"]',
    });
  });

  it("skips null/undefined", () => {
    expect(flattenConfig({ foo: null, bar: undefined, baz: "ok" })).toEqual({
      BAZ: "ok",
    });
  });
});

describe("loadEnvAndConfig", () => {
  let tmp: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "naia-env-"));
    envBackup = { ...process.env };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = envBackup;
  });

  it("loads .env from explicit path and populates process.env", () => {
    const envPath = join(tmp, "custom.env");
    writeFileSync(envPath, "FOO_BAR_BAZ=hello\nANOTHER=val\n");
    delete process.env["FOO_BAR_BAZ"];
    delete process.env["ANOTHER"];

    const report = loadEnvAndConfig({ envPath });

    expect(report.envFile).toBe(envPath);
    expect(report.loadedKeys).toContain("FOO_BAR_BAZ");
    expect(process.env["FOO_BAR_BAZ"]).toBe("hello");
    expect(process.env["ANOTHER"]).toBe("val");
  });

  it("does NOT overwrite existing process.env", () => {
    const envPath = join(tmp, ".env");
    writeFileSync(envPath, "PRESET_KEY=fromfile\n");
    process.env["PRESET_KEY"] = "fromenv";

    const report = loadEnvAndConfig({ envPath });

    expect(process.env["PRESET_KEY"]).toBe("fromenv");
    expect(report.loadedKeys).not.toContain("PRESET_KEY");
  });

  it("loads JSON config from explicit path", () => {
    const configPath = join(tmp, "cfg.json");
    writeFileSync(
      configPath,
      JSON.stringify({ anthropic: { apiKey: "k1", baseUrl: "u1" } }),
    );
    delete process.env["ANTHROPIC_APIKEY"];

    const report = loadEnvAndConfig({ configPath });

    expect(report.configFile).toBe(configPath);
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("k1");
    expect(process.env["ANTHROPIC_BASE_URL"]).toBe("u1");
  });

  it("falls through candidates if file missing (cwd only, HOME may have user .naia-agent)", () => {
    // We only assert cwd-level files are NOT picked up. HOME ~/.naia-agent
    // may exist on user machines (out of test control).
    const report = loadEnvAndConfig({ cwd: tmp });
    if (report.envFile !== undefined) {
      // If anything loaded, it must be from HOME, not our tmp.
      expect(report.envFile).not.toContain(tmp);
    }
    if (report.configFile !== undefined) {
      expect(report.configFile).not.toContain(tmp);
    }
  });

  // skipIf: ~/.naia-agent/config.json이 있는 개발자 머신에서는 candidate #4가
  // NAIA_ADK_PATH candidate #5보다 먼저 히트하여 이 테스트가 실패함.
  // CI에는 해당 파일이 없으므로 항상 실행됨.
  it.skipIf(!noHomeConfig)("loads config from NAIA_ADK_PATH/naia-settings/config.json", () => {
    // simulate naia-adk workspace layout
    const adkRoot = join(tmp, "naia-adk");
    const settingsDir = join(adkRoot, "naia-settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "config.json"),
      JSON.stringify({ anthropic: { apiKey: "adk-key", model: "claude-opus-4-6" } }),
    );
    process.env["NAIA_ADK_PATH"] = adkRoot;
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_MODEL"];

    const report = loadEnvAndConfig({ cwd: tmp });

    expect(report.configFile).toBe(join(settingsDir, "config.json"));
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("adk-key");
    expect(process.env["ANTHROPIC_MODEL"]).toBe("claude-opus-4-6");

    delete process.env["NAIA_ADK_PATH"];
  });

  it("NAIA_ADK_PATH is lower priority than .naia-agent.json", () => {
    // agent-specific config wins
    writeFileSync(
      join(tmp, ".naia-agent.json"),
      JSON.stringify({ anthropic: { apiKey: "agent-key" } }),
    );
    const adkRoot = join(tmp, "naia-adk");
    const settingsDir = join(adkRoot, "naia-settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "config.json"),
      JSON.stringify({ anthropic: { apiKey: "adk-key" } }),
    );
    process.env["NAIA_ADK_PATH"] = adkRoot;
    delete process.env["ANTHROPIC_API_KEY"];

    loadEnvAndConfig({ cwd: tmp });

    // .naia-agent.json loaded first → adk config never reached
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("agent-key");

    delete process.env["NAIA_ADK_PATH"];
  });

  it("NAIA_ADK_PATH with path traversal is safely resolved (no crash)", () => {
    // resolve() normalises ../../ to an absolute path; file won't exist → skip
    process.env["NAIA_ADK_PATH"] = "../../etc";
    delete process.env["ANTHROPIC_API_KEY"];

    // must not throw
    expect(() => loadEnvAndConfig({ cwd: tmp })).not.toThrow();

    delete process.env["NAIA_ADK_PATH"];
  });

  it("CLI flag wins over NAIA_AGENT_ENV", () => {
    const flagPath = join(tmp, "flag.env");
    writeFileSync(flagPath, "FROM_FLAG=yes\n");
    const envVarPath = join(tmp, "envvar.env");
    writeFileSync(envVarPath, "FROM_ENVVAR=yes\n");
    process.env["NAIA_AGENT_ENV"] = envVarPath;
    delete process.env["FROM_FLAG"];
    delete process.env["FROM_ENVVAR"];

    loadEnvAndConfig({ envPath: flagPath });

    expect(process.env["FROM_FLAG"]).toBe("yes");
    expect(process.env["FROM_ENVVAR"]).toBeUndefined();
  });
});
