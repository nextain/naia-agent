// Slice 1c — env + JSON config loader unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("falls through candidates if file missing", () => {
    // No envPath, no configPath, no cwd files → empty report (uses HOME paths
    // which test doesn't write to).
    const report = loadEnvAndConfig({ cwd: tmp });
    expect(report.envFile).toBeUndefined();
    expect(report.configFile).toBeUndefined();
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
