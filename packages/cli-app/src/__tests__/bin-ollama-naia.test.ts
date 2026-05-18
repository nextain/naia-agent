// packages/cli-app/src/__tests__/bin-ollama-naia.test.ts
// Fix 3 (NAIA_ANYLLM_API_KEY path), Fix 4 (OPENAI_BASE_URL alone → hasLLMConfig),
// Fix 5 (NAIA_MAIN_MODEL ?? OPENAI_MODEL priority) regression gate.
//
// R2-C CRITICAL 갭 해소:
//   T-OL-1~4: ollama/vllm path (Fix 4 + Fix 5)
//   T-NA-1~3: naia AnyLLM path (Fix 3)
//
// 실행: pnpm test (vitest run)
// 참조: docs/llm-config-standard.md, bin/naia-agent.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const binPath = resolve(repoRoot, "bin/naia-agent.ts");

function findTsxCli(): string {
  const pnpmDir = resolve(repoRoot, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith("tsx@")) {
        const c = resolve(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
        if (existsSync(c)) return c;
      }
    }
  }
  const h = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
  if (existsSync(h)) return h;
  throw new Error("tsx dist/cli.mjs not found; install tsx as devDependency");
}
const tsxCli = findTsxCli();

// Temp dir for NAIA_ADK_PATH — no credentials file → keychain lookups skipped.
let tmpAdk: string;

/** Base env: all providers cleared, DRYRUN=1, isolated NAIA_ADK_PATH. */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // clear every provider that main() or tests could inherit from parent env
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENAI_MODEL: "",
    GLM_API_KEY: "",
    VERTEX_PROJECT_ID: "",
    NAIA_ANYLLM_API_KEY: "",
    NAIA_ANYLLM_BASE_URL: "",
    NAIA_MAIN_MODEL: "",
    // Isolate from local dev credentials / DPAPI keychain on Windows
    NAIA_ADK_PATH: tmpAdk,
    // Hermetic gate: proves provider was built without making any LLM call
    NAIA_AGENT_DRYRUN: "1",
    ...overrides,
  };
}

function runBin(env: NodeJS.ProcessEnv, timeoutMs = 15_000) {
  return spawnSync(process.execPath, [tsxCli, binPath, "hi"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

// ── Fix 4 + Fix 5: OPENAI_BASE_URL 단독 경로 (ollama / vllm) ────────────────
describe("ollama/vllm path — OPENAI_BASE_URL alone (Fix 4 + Fix 5)", () => {
  beforeAll(() => {
    tmpAdk = mkdtempSync(join(tmpdir(), "naia-olnaia-"));
  });
  afterAll(() => {
    rmSync(tmpAdk, { recursive: true, force: true });
  });

  it("T-OL-1: OPENAI_BASE_URL alone → hasLLMConfig true → provider=openai-compat + dry-run OK", () => {
    // Fix 4: hasLLMConfig() now includes OPENAI_BASE_URL-alone check.
    // DRYRUN exits 0 only if buildLLMClient() succeeds → proves routing reaches ollama path.
    const r = runBin(baseEnv({ OPENAI_BASE_URL: "http://localhost:11434/v1" }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider=openai-compat");
    expect(r.stderr).toContain("dry-run OK");
  });

  it("T-OL-2: OPENAI_BASE_URL + NAIA_MAIN_MODEL → NAIA_MAIN_MODEL wins over OPENAI_MODEL", () => {
    // Fix 5: NAIA_MAIN_MODEL ?? OPENAI_MODEL ?? "llama3.2" priority order.
    const r = runBin(baseEnv({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      NAIA_MAIN_MODEL: "qwen3-custom",
      OPENAI_MODEL: "llama3.1",  // should be ignored in favour of NAIA_MAIN_MODEL
    }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("model=qwen3-custom");
  });

  it("T-OL-3: OPENAI_BASE_URL + OPENAI_MODEL, NAIA_MAIN_MODEL absent → OPENAI_MODEL used", () => {
    // Fix 5: fallback to OPENAI_MODEL when NAIA_MAIN_MODEL is unset.
    const r = runBin(baseEnv({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      OPENAI_MODEL: "llama3.1",
      // NAIA_MAIN_MODEL: "" (base env)
    }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("model=llama3.1");
  });

  it("T-OL-4: OPENAI_BASE_URL only, no model env → default llama3.2", () => {
    // Fix 5: ultimate default fallback.
    const r = runBin(baseEnv({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      // OPENAI_MODEL: "" (base env), NAIA_MAIN_MODEL: "" (base env)
    }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("model=llama3.2");
  });
});

// ── Fix 3: NAIA_ANYLLM_API_KEY 경로 (naia AnyLLM gateway) ───────────────────
describe("naia AnyLLM path — NAIA_ANYLLM_API_KEY (Fix 3)", () => {
  beforeAll(() => {
    tmpAdk = mkdtempSync(join(tmpdir(), "naia-olnaia-"));
  });
  afterAll(() => {
    rmSync(tmpAdk, { recursive: true, force: true });
  });

  it("T-NA-1: NAIA_ANYLLM_API_KEY + BASE_URL + NAIA_MAIN_MODEL → provider=naia + exit 0", () => {
    // Fix 3: configureNaiaKey() now saves NAIA_ANYLLM_API_KEY (not NAIA_API_KEY).
    // This test proves buildLLMClient() correctly reads the key under the new name.
    const r = runBin(baseEnv({
      NAIA_ANYLLM_API_KEY: "naia-fake-key",
      NAIA_ANYLLM_BASE_URL: "http://localhost:8000/v1",
      NAIA_MAIN_MODEL: "gemini-2.5-pro",
    }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider=naia");
    expect(r.stderr).toContain("model=gemini-2.5-pro");
    expect(r.stderr).toContain("dry-run OK");
  });

  it("T-NA-2: NAIA_ANYLLM_API_KEY + BASE_URL, NAIA_MAIN_MODEL unset → exit 3 + helpful error", () => {
    // buildLLMClient() naia path: NAIA_MAIN_MODEL is required (no default — avoid
    // silently billing wrong model). R2-A Q3: hasLLMConfig now also checks NAIA_MAIN_MODEL.
    const r = runBin(baseEnv({
      NAIA_ANYLLM_API_KEY: "naia-fake-key",
      NAIA_ANYLLM_BASE_URL: "http://localhost:8000/v1",
      // NAIA_MAIN_MODEL: "" (base env — triggers the "not set" error path)
    }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("NAIA_MAIN_MODEL not set");
  });

  it("T-NA-3: NAIA_ANYLLM_API_KEY without BASE_URL → naia path skipped → exit 3", () => {
    // Partial naia config should not be treated as "configured".
    const r = runBin(baseEnv({
      NAIA_ANYLLM_API_KEY: "naia-fake-key",
      // NAIA_ANYLLM_BASE_URL: "" (base env)
    }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("no LLM provider configured");
  });
});
