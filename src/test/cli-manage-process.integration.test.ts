// @spec SPEC-019 — UC20 isolated-HOME CLI process integration.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(run(env, ["config", "set", "coding.agent", "codex"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.model", "grok-4.3"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.tools", "true"]).status).toBe(0);

    const listed = run(env, ["config", "list", "--json"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).config).toEqual({
      workspace, "coding.agent": "codex", "coding.model": "grok-4.3", "coding.tools": true,
    });
    expect(JSON.parse(readFileSync(join(root, ".naia-agent", "config.json"), "utf8"))).toEqual({ adkPath: workspace });
    expect(JSON.parse(readFileSync(join(workspace, "naia-settings", "cli.json"), "utf8"))).toMatchObject({ coding: { agent: "codex", model: "grok-4.3", tools: true } });

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
    expect(run(env, ["config", "set", "coding.agent", "codex"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.model", "grok-4.3"]).status).toBe(0);
    expect(run(env, ["config", "set", "coding.tools", "false"]).status).toBe(0);
    const task = process.platform === "win32" ? "exit /b 0" : "true";
    const result = run(env, ["run", task, "--agent", "shell", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sessionOk: true });
  });

  it("migrates legacy coding.agent='pi' in cli.json to 'codex' with a one-time notice (R2)", () => {
    const { workspace, env } = sandbox();
    expect(run(env, ["config", "set", "workspace", workspace]).status).toBe(0);
    const cliConfigPath = join(workspace, "naia-settings", "cli.json");
    writeFileSync(cliConfigPath, JSON.stringify({ coding: { agent: "pi", model: "gpt-5.4", tools: false } }, null, 2));

    const first = run(env, ["config", "list", "--json"]);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('coding.agent="pi"');
    expect(JSON.parse(first.stdout).config).toMatchObject({
      "coding.agent": "codex",
      "coding.model": "gpt-5.4",
      "coding.tools": false,
    });
    expect(JSON.parse(readFileSync(cliConfigPath, "utf8"))).toEqual({
      coding: { agent: "codex", model: "gpt-5.4", tools: false },
    });

    const second = run(env, ["config", "list", "--json"]);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('coding.agent="pi"');
  });

  it("enforces --sandbox read-only on naia-agent run --no-tools and rejects --no-tools on non-codex agents (B1)", () => {
    const { root, workspace, env } = sandbox();
    expect(run(env, ["config", "set", "workspace", workspace]).status).toBe(0);
    const argsFile = join(root, "codex-args.json");
    const fakeCodex = join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
    const scriptJs = join(root, "fake-codex.mjs");
    writeFileSync(
      scriptJs,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('{"type":"thread.started","thread_id":"th_ro"}');\nconsole.log('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}');\nprocess.exit(0);\n`,
      "utf8",
    );
    if (process.platform === "win32") {
      writeFileSync(fakeCodex, `@echo off\r\n"${process.execPath}" "${scriptJs}" %*\r\n`, "utf8");
    } else {
      writeFileSync(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${scriptJs}" "$@"\n`, "utf8");
      chmodSync(fakeCodex, 0o755);
    }

    const roRun = run({ ...env, CODEX_BIN: fakeCodex }, ["run", "inspect repo", "--no-tools", "--model", "gpt-5.4", "--json"]);
    expect(roRun.status).toBe(0);
    expect(JSON.parse(roRun.stdout)).toMatchObject({ sessionOk: true });
    const capturedArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(capturedArgs).toContain("read-only");
    expect(capturedArgs).not.toContain("workspace-write");

    const invalidNoTools = run(env, ["run", "inspect repo", "--agent", "shell", "--no-tools", "--json"]);
    expect(invalidNoTools.status).toBe(64);
    expect(invalidNoTools.stderr).toContain("--no-tools(읽기 전용 샌드박스)는 codex 에이전트에서만 지원됩니다");
  });
});
