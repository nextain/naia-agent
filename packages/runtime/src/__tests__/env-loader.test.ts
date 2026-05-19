// Slice 1c — env + JSON config loader unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnv,
  flattenConfig,
  loadEnvAndConfig,
  readConfiguredAdkPath,
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

describe("readConfiguredAdkPath (Slice B — login-persisted path)", () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), "adkcfg-"));
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it("returns naiaAdkPath from a valid config.json", () => {
    const p = join(d, "config.json");
    writeFileSync(p, JSON.stringify({ naiaAdkPath: "/srv/naia-adk", other: 1 }));
    expect(readConfiguredAdkPath(p)).toBe("/srv/naia-adk");
  });
  it("graceful undefined: missing file / bad JSON / non-string / empty", () => {
    expect(readConfiguredAdkPath(join(d, "nope.json"))).toBeUndefined();
    const g = join(d, "g.json");
    writeFileSync(g, "{ not json");
    expect(readConfiguredAdkPath(g)).toBeUndefined();
    const n = join(d, "n.json");
    writeFileSync(n, JSON.stringify({ naiaAdkPath: 123 }));
    expect(readConfiguredAdkPath(n)).toBeUndefined();
    const e = join(d, "e.json");
    writeFileSync(e, JSON.stringify({ naiaAdkPath: "" }));
    expect(readConfiguredAdkPath(e)).toBeUndefined();
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

  // Task #3 Slice A — integration: loadEnvAndConfig() actually CONSUMES
  // naia-settings/llm.json (the path bin/naia-agent hits) AND naia-settings
  // outranks .env files (process.env > naia-settings > .env > json).
  it("consumes naia-settings/llm.json and it outranks .env files", () => {
    const adkDir = join(tmp, "adk");
    mkdirSync(join(adkDir, "naia-settings"), { recursive: true });
    writeFileSync(
      join(adkDir, "naia-settings", "llm.json"),
      JSON.stringify({
        version: 1,
        main: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "settings-model-X" },
        sub: { provider: "openai-compat", baseUrl: "http://127.0.0.1:11434/v1", model: "sub-m" },
        embedded: { provider: "ollama-embed", baseUrl: "http://127.0.0.1:11434/v1", model: "emb-m", dims: 1024 },
      }),
    );
    // A cwd naia-agent.env that tries to set OPENAI_MODEL — must LOSE to
    // naia-settings (applied first; .env is "if unset").
    const workDir = join(tmp, "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "naia-agent.env"), "OPENAI_MODEL=fromenvfile\n");
    for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "NAIA_SUB_MODEL", "NAIA_EMBED_MODEL"]) {
      delete process.env[k];
    }

    const report = loadEnvAndConfig({ adkPath: adkDir, cwd: workDir });

    expect(report.naiaSettings).toBeDefined();
    expect(report.naiaSettings?.skipped).toBe(false);
    expect(report.loadedKeys).toContain("OPENAI_BASE_URL");
    expect(report.loadedKeys).toContain("NAIA_EMBED_MODEL");
    // Precedence: naia-settings ran first → .env's fromenvfile is ignored.
    expect(process.env["OPENAI_MODEL"]).toBe("settings-model-X");
    expect(process.env["OPENAI_BASE_URL"]).toBe("http://127.0.0.1:11434/v1");
    expect(process.env["OPENAI_API_KEY"]).toBe("ollama"); // local sentinel
    expect(process.env["NAIA_SUB_MODEL"]).toBe("sub-m");
    expect(process.env["NAIA_EMBED_MODEL"]).toBe("emb-m");
  });
});
