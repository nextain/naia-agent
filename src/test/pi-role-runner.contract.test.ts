import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { resolveLlmRoles } from "../main/domain/llm-roles.js";
import {
  makeConfiguredRoleSubAgent,
  makePiRoleSubAgent,
  piProviderForRole,
} from "../main/adapters/pi-role-runner.js";
import type { ResolvedBin, SpawnFn } from "../main/adapters/subagent-codex.js";

const fixedCodexBin = (): ResolvedBin => ({ command: "codex", prefixArgs: [] });

function captureCodexSpawn() {
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

describe("Pi-only development role factory", () => {
  const resolved = resolveLlmRoles({
    roles: {
      main: { provider: "codex", model: "gpt-5.6" },
      expert: { provider: "claude-code-cli", model: "claude-opus-4-8" },
      sub: { inherit: "main" },
      memory: { inherit: "sub" },
    },
  });

  it("accepts a configured Codex or Claude development role", () => {
    expect(makePiRoleSubAgent(resolved, "expert").ok).toBe(true);
    expect(makePiRoleSubAgent(resolved, "main").ok).toBe(true);
    expect(makePiRoleSubAgent(resolved, "sub").ok).toBe(true);
  });

  it("maps the Codex account role to Pi's OAuth provider rather than the OpenAI API-key provider", () => {
    expect(piProviderForRole("codex")).toBe("openai-codex");
    expect(piProviderForRole("codex")).not.toBe("openai");
    expect(piProviderForRole("claude-code-cli")).toBe("anthropic");
    expect(piProviderForRole("nextain")).toBe("naia");
  });

  it("does not allow memory to become a development Pi role", () => {
    // The public role type excludes memory; runtime callers cannot select it.
    expect(makePiRoleSubAgent(resolved, "memory" as never).ok).toBe(false);
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
    expect(makePiRoleSubAgent(invalid, "main")).toEqual({
      ok: false,
      reason: "Provider 'opencode' is not permitted for Pi role 'main'",
    });
  });

  it("accepts every registered skill-capable Naia Pi model", () => {
    const valid = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "deepseek-v4-flash" },
        sub: { inherit: "main" }, memory: { inherit: "sub" }, expert: { inherit: "main" },
      },
    });
    expect(makePiRoleSubAgent(valid, "sub").ok).toBe(true);
    const invalid = resolveLlmRoles({
      roles: {
        main: { provider: "nextain", model: "invented-model" },
        sub: { inherit: "main" }, memory: { inherit: "sub" }, expert: { inherit: "main" },
      },
    });
    expect(makePiRoleSubAgent(invalid, "sub")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not registered"),
    });
  });

  it("routes a configured Codex role through the authenticated Codex adapter", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-home";
    try {
      const capture = captureCodexSpawn();
      const selected = makeConfiguredRoleSubAgent(resolved, "main", {
        codex: { resolveBin: fixedCodexBin, spawnFn: capture.spawnFn },
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
});
