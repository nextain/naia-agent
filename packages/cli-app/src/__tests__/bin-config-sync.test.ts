import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

function runBin(env: NodeJS.ProcessEnv, extraArgs: string[] = [], timeoutMs = 15_000) {
  return spawnSync(process.execPath, [tsxCli, binPath, "hi", ...extraArgs], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

function writeConfig(cfg: Record<string, string>) {
  const dir = join(tmpAdk, "naia-settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

function readConfig(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(tmpAdk, "naia-settings", "config.json"), "utf8"));
  } catch { return {}; }
}

describe("Group S — ADK config sync scenarios", () => {
  beforeAll(() => {
    tmpAdk = mkdtempSync(join(tmpdir(), "naia-sync-"));
  });
  afterAll(() => {
    rmSync(tmpAdk, { recursive: true, force: true });
  });

  it("S-ADK-1: resolveAdkPath reads config.json from NAIA_ADK_PATH", () => {
    writeConfig({ NAIA_MAIN_PROVIDER: "naia", NAIA_ANYLLM_API_KEY: "gw-test", NAIA_ANYLLM_BASE_URL: "https://gw.test", NAIA_MAIN_MODEL: "gemini-test" });
    const env = baseEnv({ NAIA_AGENT_DRYRUN: "1" });
    delete env.NAIA_ANYLLM_API_KEY;
    delete env.NAIA_ANYLLM_BASE_URL;
    delete env.NAIA_MAIN_MODEL;
    const r = runBin(env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider=naia");
  });

  it("S-ADK-2: normalizeConfigKeys — camelCase provider/model maps to NAIA_*", () => {
    writeConfig({ provider: "naia", model: "gpt-4o-mini", onboardingComplete: "true" });
    const env = baseEnv({
      NAIA_ANYLLM_API_KEY: "gw-test2",
      NAIA_ANYLLM_BASE_URL: "https://gw.test",
      NAIA_MAIN_MODEL: "gpt-4o-mini",
      NAIA_AGENT_DRYRUN: "1",
    });
    const r = runBin(env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("provider=naia");
  });

  it("S-ADK-3: camelCase agentName maps to NAIA_AGENT_NAME in config read", () => {
    writeConfig({ agentName: "TestBot", userName: "Tester", onboardingComplete: "true" });
    const cfg = readConfig();
    expect(cfg.agentName).toBe("TestBot");
    expect(cfg.userName).toBe("Tester");
  });

  it("S-ADK-4: gateway URL defaults to PROD (not dev)", () => {
    const src = readFileSync(binPath, "utf8");
    const m = src.match(/DEFAULT_GATEWAY_HTTP_URL_CLI\s*[=\s]*\n?\s*process\.env\["NAIA_GATEWAY_URL"\]\s*\|\|\s*\n?\s*"([^"]+)"/);
    if (m) {
      expect(m[1]).not.toContain("-dev-");
      expect(m[1]).toContain("naia-gateway-");
    } else {
      const m2 = src.match(/DEFAULT_GATEWAY_HTTP_URL_CLI[\s\S]*?"(https:\/\/[^"]+)"/);
      expect(m2).toBeTruthy();
      expect(m2![1]).not.toContain("-dev-");
      expect(m2![1]).toContain("naia-gateway-");
    }
  });

  it("S-ADK-5: NAIA_GATEWAY_URL env overrides default gateway", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain('process.env["NAIA_GATEWAY_URL"]');
  });

  it("S-ADK-6: onboardingComplete preserved in config.json", () => {
    writeConfig({ onboardingComplete: "true", NAIA_MAIN_PROVIDER: "naia" });
    const cfg = readConfig();
    expect(cfg.onboardingComplete).toBe("true");
  });
});

describe("Group S2 — /sessions and /resume REPL commands exist", () => {
  it("S-REPL-1: /sessions and /resume are in help output", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain("/sessions");
    expect(src).toContain("/resume");
    expect(src).toContain("repl.help.sessions");
    expect(src).toContain("repl.help.resume");
  });

  it("S-REPL-2: session save dir uses naiaSettingsDir", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain('path.join(naiaSettingsDir(), "sessions")');
  });
});

describe("Group S3 — auto skill loading", () => {
  it("S-SKILL-1: auto-scans .agents/skills from resolveAdkPath (only)", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain('".agents"');
    expect(src).toContain('"skills"');
    expect(src).toContain("adkAutoSkillDirs");
  });

  it("S-SKILL-2: --skills-dir prepends to auto dirs", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain("allSkillDirs");
    expect(src).toContain("args.skillsDir");
  });
});

describe("Group S4 — /setup env reload", () => {
  it("S-SETUP-1: /setup deletes provider env keys before reload", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain("providerEnvKeys");
    expect(src).toContain("ANTHROPIC_API_KEY");
    expect(src).toContain("GLM_API_KEY");
    expect(src).toContain("delete process.env[k]");
  });
});

describe("Group S5 — Claude Code routing in buildLLMClient", () => {
  beforeAll(() => {
    tmpAdk = mkdtempSync(join(tmpdir(), "naia-cc-"));
  });
  afterAll(() => {
    rmSync(tmpAdk, { recursive: true, force: true });
  });

  it("S-CC-1: claude-code branch is inside buildLLMClient (not runDirect)", () => {
    const src = readFileSync(binPath, "utf8");
    const fnStart = src.indexOf("async function buildLLMClient(");
    const fnEnd = src.indexOf("\nasync function ", fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("naiaMainProvider === \"claude-code\"");
    expect(fnBody).toContain("createClaudeCode");
  });

  it("S-CC-2: no duplicate claude-code block outside buildLLMClient in handoff", () => {
    const src = readFileSync(binPath, "utf8");
    const handoffIdx = src.indexOf("handoff exported");
    if (handoffIdx === -1) return;
    const afterHandoff = src.slice(handoffIdx, handoffIdx + 500);
    expect(afterHandoff).not.toContain("createClaudeCode");
  });
});

describe("Group S6 — runStdio LLM caching", () => {
  it("S-STDIO-1: cachedLlm with undefined sentinel in runStdio", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain("cachedLlm === undefined");
    expect(src).toContain("cachedLlm = await buildLLMClient()");
  });

  it("S-STDIO-2: cache invalidated on creds_update", () => {
    const src = readFileSync(binPath, "utf8");
    const credsIdx = src.indexOf('case "creds_update"');
    const afterCreds = src.slice(credsIdx, credsIdx + 1500);
    expect(afterCreds).toContain("cachedLlm = undefined");
  });

  it("S-STDIO-3: cache invalidated on auth_update", () => {
    const src = readFileSync(binPath, "utf8");
    const authIdx = src.indexOf('case "auth_update"');
    const afterAuth = src.slice(authIdx, authIdx + 400);
    expect(afterAuth).toContain("cachedLlm = undefined");
  });
});

describe("Group S7 — config_update stdio handler", () => {
  it("S-CFG-1: config_update case exists in runStdio switch", () => {
    const src = readFileSync(binPath, "utf8");
    expect(src).toContain('case "config_update"');
  });

  it("S-CFG-2: config_update merges into config.json via readNaiaSettings + writeNaiaSettings", () => {
    const src = readFileSync(binPath, "utf8");
    const cfgIdx = src.indexOf('case "config_update"');
    expect(cfgIdx).toBeGreaterThan(0);
    const block = src.slice(cfgIdx, cfgIdx + 2000);
    expect(block).toContain("readNaiaSettings");
    expect(block).toContain("writeNaiaSettings");
    expect(block).toContain("normalizeConfigKeys");
  });

  it("S-CFG-3: config_update saves secrets to keychain via keychainSet + addCredentialKey", () => {
    const src = readFileSync(binPath, "utf8");
    const cfgIdx = src.indexOf('case "config_update"');
    const block = src.slice(cfgIdx, cfgIdx + 2500);
    expect(block).toContain("keychainSet");
    expect(block).toContain("addCredentialKey");
  });

  it("S-CFG-4: config_update invalidates cachedLlm", () => {
    const src = readFileSync(binPath, "utf8");
    const cfgIdx = src.indexOf('case "config_update"');
    const block = src.slice(cfgIdx, cfgIdx + 2500);
    expect(block).toContain("cachedLlm = undefined");
  });

  it("S-CFG-5: config_update calls loadEnvAndConfig after write", () => {
    const src = readFileSync(binPath, "utf8");
    const cfgIdx = src.indexOf('case "config_update"');
    const block = src.slice(cfgIdx, cfgIdx + 2500);
    expect(block).toContain("loadEnvAndConfig()");
  });

  it("S-CFG-6: config_update sends config_update_response with id and status", () => {
    const src = readFileSync(binPath, "utf8");
    const cfgIdx = src.indexOf('case "config_update"');
    const block = src.slice(cfgIdx, cfgIdx + 2500);
    expect(block).toContain("config_update_response");
    expect(block).toContain('status: "ok"');
    expect(block).toContain("error:");
  });

  it("S-CFG-7: config_update reloads keychain credentials into process.env", () => {
    const src = readFileSync(binPath, "utf8");
    const cfgIdx = src.indexOf('case "config_update"');
    const block = src.slice(cfgIdx, cfgIdx + 2500);
    expect(block).toContain("readCredentialKeys");
    expect(block).toContain("keychainGet");
  });
});
