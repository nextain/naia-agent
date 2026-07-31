// @spec SPEC-019 — UC20 isolated-HOME CLI process integration.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "naia-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "naia-settings"), { recursive: true });
  writeFileSync(join(workspace, "naia-settings", "config.json"), '{"provider":"nextain","model":"grok-4.3"}');
  const env = {
    ...process.env,
    USERPROFILE: root,
    HOME: root,
    APPDATA: join(root, "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "AppData", "Local"),
    NAIA_ADK_PATH: "",
    NAIA_API_KEY: "",
    NAIA_ANYLLM_API_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
  };
  return { root, workspace, env };
}

const cli = join(process.cwd(), "bin", "naia-agent.mjs");
function run(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 30_000 });
}

describe("TEST-S-020 isolated HOME management flow", () => {
  it("exposes a stable version command", () => {
    const { env } = sandbox();
    const result = run(env, ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("config is allowlisted, atomic-readable, and models/doctor JSON stay machine-readable", () => {
    const { root, workspace, env } = sandbox();
    expect(run(env, ["config", "set", "workspace", workspace]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.agent", "pi"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.model", "grok-4.3"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.tools", "true"]).status).toBe(0);

    const listed = run(env, ["config", "list", "--json"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).config).toEqual({
      workspace, "coding.agent": "pi", "coding.model": "grok-4.3", "coding.tools": true,
    });
    expect(JSON.parse(readFileSync(join(root, ".naia-agent", "config.json"), "utf8"))).toEqual({ adkPath: workspace });
    expect(JSON.parse(readFileSync(join(workspace, "naia-settings", "cli.json"), "utf8"))).toMatchObject({ coding: { agent: "pi", model: "grok-4.3", tools: true } });

    const models = run(env, ["models", "--json"]);
    expect(models.status).toBe(0);
    const modelBody = JSON.parse(models.stdout);
    expect(modelBody.source).toBe("fallback");
    expect(modelBody.models).toContainEqual(expect.objectContaining({ id: "grok-4.3", tools: true }));
    const doctor = run(env, ["doctor", "--json"]);
    expect(doctor.status).toBe(1);
    const diagnosis = JSON.parse(doctor.stdout);
    expect(diagnosis.ready).toBe(false);
    expect(diagnosis.checks.some((x: any) => x.component === "account.naia" && x.status === "fail")).toBe(true);
  });

  it("lists/shows existing transcript, redacts common secrets, and ignores incomplete turn", () => {
    const { workspace, env } = sandbox();
    expect(run(env, ["config", "set", "workspace", workspace]).status).toBe(0);
    const conversations = join(workspace, "conversations");
    mkdirSync(conversations, { recursive: true });
    writeFileSync(join(conversations, "cli-safe.jsonl"), [
      JSON.stringify({ role: "user", content: "hello api_key=super-secret-value", timestamp: 1 }),
      JSON.stringify({ role: "assistant", content: "answer", timestamp: 1 }),
      JSON.stringify({ role: "user", content: "incomplete", timestamp: 2 }),
    ].join("\n"));
    const listed = run(env, ["session", "list", "--json"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("cli-safe");
    expect(listed.stdout).not.toContain("super-secret-value");
    const shown = run(env, ["session", "show", "cli-safe", "--json"]);
    expect(shown.status).toBe(0);
    const body = JSON.parse(shown.stdout);
    expect(body.messages).toHaveLength(2);
    expect(shown.stdout).toContain("[REDACTED]");
    expect(shown.stdout).not.toContain("super-secret-value");
    expect(run(env, ["session", "show", "../escape"]).status).toBe(64);
  });

  it.skipIf(process.platform !== "win32")("stores Naia login in DPAPI, never plaintext, reports status, and logs out", () => {
    const { root, workspace, env } = sandbox();
    expect(run(env, ["config", "set", "workspace", workspace]).status).toBe(0);
    const secret = "naia-test-secret-value-123";
    const login = run(env, ["auth", "login", "--provider", "naia", "--key", secret]);
    expect(login.status).toBe(0);
    expect(`${login.stdout}${login.stderr}`).not.toContain(secret);
    const blob = join(workspace, "naia-settings", ".keys", "NAIA_ANYLLM_API_KEY.dpapi");
    expect(readFileSync(blob).toString("utf8")).not.toContain(secret);
    expect(() => readFileSync(join(root, ".naia-agent", ".env"), "utf8")).toThrow();
    const status = run(env, ["auth", "status", "--provider", "naia", "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).accounts[0]).toMatchObject({ authenticated: true, source: "dpapi" });
    expect(status.stdout).not.toContain(secret);
    expect(run(env, ["auth", "logout", "--provider", "naia"]).status).toBe(0);
    expect(JSON.parse(run(env, ["auth", "status", "--provider", "naia", "--json"]).stdout).accounts[0].authenticated).toBe(false);
  });

  it("explicit run flags override stored coding defaults in a real child process", () => {
    const { workspace, env } = sandbox();
    expect(run(env, ["config", "set", "workspace", workspace]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.agent", "pi"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.model", "grok-4.3"]).status).toBe(0);
    const task = process.platform === "win32" ? "exit /b 0" : "true";
    const result = run(env, ["run", task, "--agent", "shell", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sessionOk: true });
  });
});
