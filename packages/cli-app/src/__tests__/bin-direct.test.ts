// Integration test for bin/naia-agent.ts direct mode.
// Spawns the bin as a subprocess; no real LLM required.
// Satisfies slice #21 success criterion item 3 (통합 검증 1+).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const binPath = resolve(repoRoot, "bin/naia-agent.ts");

// Find tsx CLI mjs — cross-platform, no shell wrapper needed.
function findTsxCli(): string {
  // Preferred: pnpm store copy (pinned version)
  const pnpmDir = resolve(repoRoot, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith("tsx@")) {
        const candidate = resolve(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  // Fallback: hoisted install
  const hoisted = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
  if (existsSync(hoisted)) return hoisted;
  throw new Error("tsx dist/cli.mjs not found; install tsx as devDependency");
}

const tsxCli = findTsxCli();

function runBin(args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 15_000) {
  return spawnSync(process.execPath, [tsxCli, binPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

describe("bin/naia-agent direct mode (G01 / #21)", () => {
  it("exits 3 with helpful error when no LLM provider configured", () => {
    const r = runBin(["test prompt"], {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GLM_API_KEY: "",
      VERTEX_PROJECT_ID: "",
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no LLM provider configured");
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("exits 3 with usage message for unknown arg", () => {
    const r = runBin(["--unknown-flag-xyz"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("unknown arg");
  });

  it("supervisor mode with shell adapter runs without LLM (exit 0)", () => {
    const r = runBin(
      [
        "echo test",
        "--mode=supervisor",
        "--no-verify",
        "--adapter", "shell",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('integration-ok\\n')",
      ],
      undefined,
      20_000,
    );
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("integration-ok");
  }, 25_000);
});
