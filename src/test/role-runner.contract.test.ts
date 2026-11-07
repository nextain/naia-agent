import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveLlmRoles } from "../main/domain/llm-roles.js";
import {
  cliWorkerForProvider,
  CLI_ROLE_WORKERS,
  isSupportedNaiaRoleModel,
  makeConfiguredRoleSubAgent,
  makeRoleProcessingPlans,
  makeRoleSubAgent,
  makeRoleSupervisorRunner,
  normalizeSupportedNaiaRoleModel,
} from "../main/adapters/role-runner.js";
import type { ResolvedBin, SpawnFn } from "../main/adapters/subprocess-session.js";
import type { TaskSpec } from "../main/domain/orchestration.js";

const fixedBin = (command: string): (() => ResolvedBin) => () => ({ command, prefixArgs: [] });

function captureSpawn() {
  let captured: { command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv } | undefined;
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const spawnFn: SpawnFn = (command, args, options) => {
    captured = { command, args, cwd: options.cwd, env: options.env };
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on(event: string, callback: (...args: unknown[]) => void) {
        handlers[event] = callback;
        return this;
      },
      kill: () => true,
    };
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    get captured() { return captured; },
  };
}

describe("Codex-default development role factory", () => {
  const resolved = resolveLlmRoles({
    roles: {
      main: { provider: "codex", model: "gpt-5.6" },
      expert: { provider: "claude-code-cli", model: "claude-opus-4-8" },
      sub: { inherit: "main" },
      memory: { inherit: "sub" },
    },
  });

  it("accepts a configured Codex or Claude development role", () => {
    expect(makeRoleSubAgent(resolved, "expert").ok).toBe(true);
    expect(makeRoleSubAgent(resolved, "main").ok).toBe(true);
    expect(makeRoleSubAgent(resolved, "sub").ok).toBe(true);
  });

  it("does not allow memory to become a development role", () => {
    expect(makeRoleSubAgent(resolved, "memory" as never).ok).toBe(false);
  });

  it("fails closed for an unsupported provider rather than falling back", () => {
    const invalid = resolveLlmRoles({
      roles: {
        main: { provider: "opencode", model: "anything" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    expect(makeRoleSubAgent(invalid, "main")).toEqual({
      ok: false,
      reason: "Provider 'opencode' is not permitted for role 'main'",
    });
  });

  it("validates Naia role models case-insensitively and blocks account-provider roles before spawn (B2)", () => {
    expect(isSupportedNaiaRoleModel("HCX-007")).toBe(true);
    expect(isSupportedNaiaRoleModel("hcx-007")).toBe(true);
    expect(isSupportedNaiaRoleModel("hcx-dash-002")).toBe(true);
    expect(isSupportedNaiaRoleModel("grok-4.3")).toBe(true);
    expect(isSupportedNaiaRoleModel("deepseek-v4-flash")).toBe(true);
    expect(isSupportedNaiaRoleModel("gpt-4o")).toBe(false);
    expect(isSupportedNaiaRoleModel(undefined)).toBe(false);
    expect(normalizeSupportedNaiaRoleModel("hcx-007")).toBe("HCX-007");
    expect(normalizeSupportedNaiaRoleModel("hcx-dash-002")).toBe("HCX-DASH-002");

    const registeredNaia = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "hcx-007" },
        sub: { inherit: "main" }, memory: { inherit: "sub" }, expert: { inherit: "main" },
      },
    });
    expect(makeRoleSubAgent(registeredNaia, "sub")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Account provider 'nextain' (model 'HCX-007') is not supported on the Codex role runner"),
    });
    const invalid = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "invented-model" },
        sub: { inherit: "main" }, memory: { inherit: "sub" }, expert: { inherit: "main" },
      },
    });
    expect(makeRoleSubAgent(invalid, "sub")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not registered"),
    });
  });
});

describe("Configured development role adapter routing (Codex default, Claude, Grok)", () => {
  const resolved = resolveLlmRoles({
    roles: {
      main: { provider: "codex", model: "gpt-5.6" },
      expert: { provider: "claude-code-cli", model: "claude-opus-4-8" },
      sub: { inherit: "main" },
      memory: { inherit: "sub" },
    },
  });

  it("table maps provider ids to the expected CLI worker or Codex default", () => {
    expect(CLI_ROLE_WORKERS).toHaveProperty("codex");
    expect(CLI_ROLE_WORKERS).toHaveProperty("claude");
    expect(CLI_ROLE_WORKERS).toHaveProperty("grok");
    expect(cliWorkerForProvider("codex")).toBe("codex");
    expect(cliWorkerForProvider("claude-code-cli")).toBe("claude");
    expect(cliWorkerForProvider("grok")).toBe("grok");
    expect(cliWorkerForProvider("openai-codex")).toBeUndefined();
    expect(cliWorkerForProvider("claude")).toBeUndefined();
    expect(cliWorkerForProvider("claude-code")).toBeUndefined();
    expect(cliWorkerForProvider("anthropic")).toBeUndefined();
    expect(cliWorkerForProvider("nextain")).toBeUndefined();
  });

  it("routes a configured Codex role through the authenticated Codex adapter", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-home";
    try {
      const capture = captureSpawn();
      const selected = makeConfiguredRoleSubAgent(resolved, "main", {
        codex: { resolveBin: fixedBin("codex"), spawnFn: capture.spawnFn },
      });
      expect(selected.ok).toBe(true);
      if (!selected.ok) return;

      selected.agent.spawn({ prompt: "create the requested files", workdir: "/tmp/bound-workspace" });
      expect(capture.captured).toMatchObject({ command: "codex", cwd: "/tmp/bound-workspace" });
      expect(capture.captured?.args).toEqual(expect.arrayContaining([
        "--sandbox", "workspace-write", "--model", "gpt-5.6", "--cd", "/tmp/bound-workspace",
      ]));
      expect(capture.captured?.env?.CODEX_HOME).toBe("/tmp/codex-home");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("routes a configured Claude role through the Claude Code CLI adapter", () => {
    const capture = captureSpawn();
    const selected = makeConfiguredRoleSubAgent(resolved, "expert", {
      claude: { resolveBin: fixedBin("claude"), spawnFn: capture.spawnFn },
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    selected.agent.spawn({ prompt: "review changes", workdir: "/tmp/claude-workspace" });
    expect(capture.captured).toMatchObject({ command: "claude", cwd: "/tmp/claude-workspace" });
    expect(capture.captured?.args).toEqual(expect.arrayContaining([
      "-p", "review changes", "--output-format", "stream-json", "--verbose", "--model", "claude-opus-4-8",
      "--permission-mode", "acceptEdits", "--add-dir", "/tmp/claude-workspace",
    ]));
    expect(capture.captured?.args).not.toContain("--dangerously-skip-permissions");
  });

  it("routes a configured Grok role through the Grok Build CLI adapter with subscription env", () => {
    const grokResolved = resolveLlmRoles({
      roles: {
        main: { provider: "grok", model: "grok-4.6" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    const previousXai = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "should-be-stripped";
    try {
      const capture = captureSpawn();
      const selected = makeConfiguredRoleSubAgent(grokResolved, "main", {
        grok: { resolveBin: fixedBin("grok"), spawnFn: capture.spawnFn },
      });
      expect(selected.ok).toBe(true);
      if (!selected.ok) return;

      selected.agent.spawn({ prompt: "write test", workdir: "/tmp/grok-workspace" });
      expect(capture.captured).toMatchObject({ command: "grok", cwd: "/tmp/grok-workspace" });
      expect(capture.captured?.args).toEqual(expect.arrayContaining([
        "-p", "write test", "--output-format", "streaming-messages-json", "--include-partial-messages", "--cwd", "/tmp/grok-workspace", "-m", "grok-4.6",
        "--permission-mode", "acceptEdits",
      ]));
      expect(capture.captured?.args).not.toContain("--always-approve");
      expect(capture.captured?.env?.XAI_API_KEY).toBeUndefined();
    } finally {
      if (previousXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousXai;
    }
  });

  it("contract: unrelated secret NAIA_TEST_SECRET does not reach Claude and Grok child env, and PATH does", () => {
    const previousSecret = process.env.NAIA_TEST_SECRET;
    process.env.NAIA_TEST_SECRET = "super-secret-12345";
    try {
      const captureClaude = captureSpawn();
      const claudeSelected = makeConfiguredRoleSubAgent(resolved, "expert", {
        claude: { resolveBin: fixedBin("claude"), spawnFn: captureClaude.spawnFn },
      });
      expect(claudeSelected.ok).toBe(true);
      if (claudeSelected.ok) {
        claudeSelected.agent.spawn({ prompt: "task", workdir: "/tmp/claude-ws" });
        expect(captureClaude.captured?.env).toBeDefined();
        expect(captureClaude.captured?.env?.NAIA_TEST_SECRET).toBeUndefined();
        expect(captureClaude.captured?.env?.PATH).toBeDefined();
      }

      const grokResolved = resolveLlmRoles({
        roles: {
          main: { provider: "grok", model: "grok-4.6" },
          sub: { inherit: "main" },
          memory: { inherit: "sub" },
          expert: { inherit: "main" },
        },
      });
      const captureGrok = captureSpawn();
      const grokSelected = makeConfiguredRoleSubAgent(grokResolved, "main", {
        grok: { resolveBin: fixedBin("grok"), spawnFn: captureGrok.spawnFn },
      });
      expect(grokSelected.ok).toBe(true);
      if (grokSelected.ok) {
        grokSelected.agent.spawn({ prompt: "task", workdir: "/tmp/grok-ws" });
        expect(captureGrok.captured?.env).toBeDefined();
        expect(captureGrok.captured?.env?.NAIA_TEST_SECRET).toBeUndefined();
        expect(captureGrok.captured?.env?.PATH).toBeDefined();
      }
    } finally {
      if (previousSecret === undefined) delete process.env.NAIA_TEST_SECRET;
      else process.env.NAIA_TEST_SECRET = previousSecret;
    }
  });

  it("fails closed before spawn for non-CLI account providers (anthropic, naia/nextain) so Naia model IDs are never passed to Codex (B2)", () => {
    const anthropicResolved = resolveLlmRoles({
      roles: {
        main: { provider: "anthropic", model: "claude-sonnet-4-6" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    const captureAnthropic = captureSpawn();
    const selectedAnthropic = makeConfiguredRoleSubAgent(anthropicResolved, "main", {
      codex: { resolveBin: fixedBin("codex"), spawnFn: captureAnthropic.spawnFn },
    });
    expect(selectedAnthropic).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Account provider 'anthropic' (model 'claude-sonnet-4-6') is not supported on the Codex role runner after Pi removal"),
    });
    expect(captureAnthropic.captured).toBeUndefined();

    const naiaResolved = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "deepseek-v4-flash" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    const captureNaia = captureSpawn();
    const selectedNaia = makeConfiguredRoleSubAgent(naiaResolved, "main", {
      codex: {
        resolveBin: fixedBin("codex"),
        spawnFn: captureNaia.spawnFn,
      },
    });
    expect(selectedNaia).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Account provider 'nextain' (model 'deepseek-v4-flash') is not supported on the Codex role runner after Pi removal"),
    });
    expect(captureNaia.captured).toBeUndefined();
    expect(makeRoleProcessingPlans(anthropicResolved)).toEqual([]);
    expect(makeRoleProcessingPlans(naiaResolved)).toEqual([]);
  });

  it("fails closed when role configuration is invalid or provider is unsupported", () => {
    expect(makeConfiguredRoleSubAgent(null, "main")).toEqual({
      ok: false,
      reason: "LLM role configuration is missing or invalid",
    });

    const unsupported = resolveLlmRoles({
      roles: {
        main: { provider: "opencode", model: "unsupported" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    expect(makeConfiguredRoleSubAgent(unsupported, "main")).toEqual({
      ok: false,
      reason: "Provider 'opencode' is not permitted for role 'main'",
    });
  });

  it("passes processing authorization plans identically across workers", () => {
    const multiRoles = resolveLlmRoles({
      roles: {
        expert: { provider: "claude-code-cli", model: "claude-opus-4-8" },
        main: { provider: "codex", model: "gpt-5.6" },
        sub: { provider: "grok", model: "grok-4.6" },
        memory: { inherit: "sub" },
      },
    });
    const plans = makeRoleProcessingPlans(multiRoles);
    expect(plans).toHaveLength(3);
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "codex", model: "gpt-5.6", when: { key: "agent", values: ["main"] } }),
      expect.objectContaining({ provider: "claude-code-cli", model: "claude-opus-4-8", when: { key: "agent", values: ["expert"] } }),
      expect.objectContaining({ provider: "grok", model: "grok-4.6", when: { key: "agent", values: ["sub"] } }),
    ]));
  });

  it("supervises configured role via makeRoleSupervisorRunner and emits failing verification check on role failure (B2)", async () => {
    const multiRoles = resolveLlmRoles({
      roles: {
        expert: { provider: "claude-code-cli", model: "claude-opus-4-8" },
        main: { provider: "codex", model: "gpt-5.6" },
        sub: { provider: "grok", model: "grok-4.6" },
        memory: { inherit: "sub" },
      },
    });
    let supervisedAgent: unknown;
    let supervisedTask: TaskSpec | undefined;
    const capture = captureSpawn();
    const runner = makeRoleSupervisorRunner(
      multiRoles,
      async (agent, task) => {
        supervisedAgent = agent;
        supervisedTask = task;
        agent.spawn(task);
      },
      {
        codex: { resolveBin: fixedBin("codex"), spawnFn: capture.spawnFn },
      },
    );
    const egress = { event: () => {}, report: () => {} };
    const res = await runner("main", { prompt: "test task", workdir: "/tmp/ws" }, new AbortController().signal, egress);
    expect(res.ok).toBe(true);
    expect(supervisedAgent).toBeDefined();
    expect(supervisedTask).toEqual({ prompt: "test task", workdir: "/tmp/ws" });
    expect(capture.captured).toBeDefined();
    expect(capture.captured?.command).toBe("codex");
    expect(capture.captured?.cwd).toBe("/tmp/ws");

    const naiaRole = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "grok-4.3" },
        sub: { inherit: "main" },
        memory: { inherit: "sub" },
        expert: { inherit: "main" },
      },
    });
    const failedReports: unknown[] = [];
    const failedEvents: unknown[] = [];
    const failRunner = makeRoleSupervisorRunner(naiaRole, async () => {});
    const failRes = await failRunner(
      "main",
      { prompt: "test task", workdir: "/tmp/ws" },
      new AbortController().signal,
      { event: (e) => failedEvents.push(e), report: (r) => failedReports.push(r) },
    );
    expect(failRes.ok).toBe(false);
    expect(failedEvents).toEqual([
      expect.objectContaining({ kind: "session_end", ok: false, reason: expect.stringContaining("not supported on the Codex role runner") }),
    ]);
    expect(failedReports).toEqual([
      {
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        sessionOk: false,
        verification: {
          ok: false,
          checks: [
            {
              name: "role",
              pass: false,
              details: expect.stringContaining("not supported on the Codex role runner"),
            },
          ],
        },
      },
    ]);
  });
});
