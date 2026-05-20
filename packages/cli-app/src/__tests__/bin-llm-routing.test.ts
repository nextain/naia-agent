// CI gate for bin/naia-agent.ts provider routing — naia-agent#39 G1.
//
// Adversarial review proved the prior coverage was parse-only theater: a
// renamed `case "claude-code"` label / `return null` survived 263/263.
// buildLLMClientFromManifest legitimately lives in the composition root
// (bin) — it composes runtime's manifest-trust + providers' VercelClient/
// ai-sdk SDKs; a cross-package extraction violates package dep boundaries.
// So this gate spawns the real bin (no boundary violation) with the
// test-only NAIA_AGENT_DRYRUN hook: the LLM client is built (routing
// proven) then the process exits 0 WITHOUT any LLM call (hermetic, no
// credit). A broken provider branch → null → exit 3 → these tests FAIL.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const binPath = resolve(repoRoot, "bin/naia-agent.ts");

function findTsxCli(): string {
  const pnpmDir = resolve(repoRoot, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith("tsx@")) {
        const candidate = resolve(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const hoisted = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
  if (existsSync(hoisted)) return hoisted;
  throw new Error("tsx dist/cli.mjs not found; install tsx as devDependency");
}
const tsxCli = findTsxCli();

function runBin(args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 30_000) {
  return spawnSync(process.execPath, [tsxCli, binPath, ...args], {
    cwd: repoRoot,
    // Point NAIA_ADK_PATH to a temp dir so keychainGet is never invoked
    // (credentials file absent → credKeys empty → no DPAPI/secret-tool spawns).
    env: { ...process.env, NAIA_ADK_PATH: dir, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

let dir: string;
function manifest(backend: string, model = "sonnet"): string {
  const p = join(dir, `${backend.replace(/[^a-z0-9]/gi, "_")}.service.json`);
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: "0.1.0",
      name: "routing-gate",
      persona: { systemPrompt: "terse" },
      llm: { backend, model },
      memory: { binding: "in-memory" },
    }),
  );
  return p;
}

describe("bin provider routing gate (naia-agent#39 G1)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "naia-routing-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backend "claude-code" routes to a built client with NO API key (subscription)', () => {
    const r = runBin(["hi", "--service", manifest("claude-code")], {
      NAIA_AGENT_DRYRUN: "1",
      // No subscription/key auth needed just to build the client; prove it.
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GLM_API_KEY: "",
      VERTEX_PROJECT_ID: "",
    });
    // Routing actually reached `case "claude-code"` (not default → null → exit 3):
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider=claude-code");
    expect(r.stderr).toContain("subscription, no API key");
    expect(r.stderr).toContain("dry-run OK");
    expect(r.stderr).toContain("backend=claude-code");
  });

  it("unknown backend → exit 3 (default case; supported list names claude-code)", () => {
    const r = runBin(["hi", "--service", manifest("definitely-not-a-backend")], {
      NAIA_AGENT_DRYRUN: "1",
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("unknown manifest llm.backend");
    expect(r.stderr).toContain("claude-code");
  });
});
