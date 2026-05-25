import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
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
  throw new Error("tsx not found");
}
const tsxCli = findTsxCli();

let tmpAdk: string;

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENAI_MODEL: "",
    GLM_API_KEY: "",
    VERTEX_PROJECT_ID: "",
    NAIA_ANYLLM_API_KEY: "",
    NAIA_ANYLLM_BASE_URL: "",
    NAIA_MAIN_MODEL: "",
    NAIA_ADK_PATH: tmpAdk,
    NAIA_AGENT_DRYRUN: "1",
    ...overrides,
  };
}

function runBin(env: NodeJS.ProcessEnv, extraArgs: string[] = [], input?: string, timeoutMs = 15_000) {
  return spawnSync(process.execPath, [tsxCli, binPath, ...extraArgs], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    input: input ?? undefined,
    timeout: timeoutMs,
  });
}

function writeConfig(cfg: Record<string, string>) {
  const dir = join(tmpAdk, "naia-settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

function configExists(): boolean {
  return existsSync(join(tmpAdk, "naia-settings", "config.json"));
}

describe("Integration — config lifecycle + i18n + skill scan", () => {
  beforeAll(() => {
    tmpAdk = mkdtempSync(join(tmpdir(), "naia-integ-"));
  });
  afterAll(() => {
    rmSync(tmpAdk, { recursive: true, force: true });
  });

  it("INT-1: config.json loaded → provider recognized → DRYRUN exit 0", () => {
    writeConfig({ NAIA_MAIN_PROVIDER: "naia", NAIA_ANYLLM_API_KEY: "gw-key", NAIA_ANYLLM_BASE_URL: "https://gw.test", NAIA_MAIN_MODEL: "gemini-3" });
    const env = baseEnv();
    delete env.NAIA_ANYLLM_API_KEY;
    delete env.NAIA_ANYLLM_BASE_URL;
    delete env.NAIA_MAIN_MODEL;

    const r = runBin(env, ["hello"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider=naia");
    expect(r.stderr).toContain("gemini-3");
  });

  it("INT-2: config deleted → no provider → exit 3", () => {
    if (configExists()) unlinkSync(join(tmpAdk, "naia-settings", "config.json"));

    const env = baseEnv();
    delete env.NAIA_AGENT_DRYRUN;
    const r = runBin(env, ["hello"]);
    expect(r.status).toBe(3);
  });

  it("INT-3: new config written → re-recognized", () => {
    writeConfig({ NAIA_MAIN_PROVIDER: "naia", NAIA_ANYLLM_API_KEY: "new-key", NAIA_ANYLLM_BASE_URL: "https://gw2.test", NAIA_MAIN_MODEL: "gemini-4" });
    const env = baseEnv();
    delete env.NAIA_ANYLLM_API_KEY;
    delete env.NAIA_ANYLLM_BASE_URL;
    delete env.NAIA_MAIN_MODEL;

    const r = runBin(env, ["hello"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("gemini-4");
  });

  it("INT-4: NAIA_LOCALE=ko → i18n Korean in no-provider error", () => {
    if (configExists()) unlinkSync(join(tmpAdk, "naia-settings", "config.json"));
    const env = baseEnv({ NAIA_LOCALE: "ko" });
    delete env.NAIA_AGENT_DRYRUN;
    delete env.NAIA_ANYLLM_API_KEY;
    delete env.NAIA_ANYLLM_BASE_URL;
    delete env.NAIA_MAIN_MODEL;

    const r = runBin(env, ["hello"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/LLM|provider|login/i);
  });

  it("INT-5: i18n keys exist for all REPL commands in source", () => {
    const src = readFileSync(binPath, "utf8");
    const i18nKeys = [
      "repl.help.reset", "repl.help.setup", "repl.help.factory_reset",
      "repl.help.sessions", "repl.help.resume", "repl.help.help", "repl.help.exit",
      "repl.reset.done", "repl.setup.done", "repl.setup.failed",
      "repl.factory_reset.done", "repl.sessions.empty",
      "repl.resume.restored", "repl.resume.failed",
    ];
    for (const key of i18nKeys) {
      expect(src).toContain(`t("${key}")`);
    }
  });

  it("INT-6: onboardingChat returns English strings (no hardcoded Korean)", () => {
    const src = readFileSync(binPath, "utf8");
    const fnMatch = src.match(/function onboardingChat[\s\S]*?^ \}/m);
    expect(fnMatch).toBeTruthy();
    const fn = fnMatch![0];
    const koreanPattern = /[\u3131-\u318E\uAC00-\uD7A3]/;
    expect(koreanPattern.test(fn)).toBe(false);
  });

  it("INT-7: skill auto-scan only .agents/skills (not skills/)", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain('".agents"');
    expect(src).toContain('"skills"');
    const scanBlock = src.match(/const candidate = path\.join\(adkBase,[^)]+\)/);
    expect(scanBlock).toBeTruthy();
    expect(scanBlock![0]).toContain('".agents"');
    expect(scanBlock![0]).toContain('"skills"');
    expect(src).not.toMatch(/for\s*\(const sub of.*\.agents.*skills.*skills/);
  });
});
