import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  makeCodexContinuousLoop,
  makeCodexOnlyTeamProfile,
  makePiContinuousLoop,
  makePiOnlyTeamProfile,
} from "../main/composition/codex-continuous-loop.js";
import { composeIssueTeamAgents } from "../main/composition/mixed-issue-team-agents.js";
import type { SpawnFn } from "../main/adapters/subprocess-session.js";

const binding = (model: string) => ({ provider: "naia", model });

describe("Codex continuous loop contract (FR-LOOP-001, FR-LOOP-005..011, FR-CODEX-SWAP-2)", () => {
  it("pins all authored team roles to built-in Codex with one writing role", () => {
    const profile = makeCodexOnlyTeamProfile({ roles: { explorer: binding("deepseek-v4-flash"),
      implementer: binding("grok-4.3"), tester: binding("deepseek-v4-flash"),
      reviewer: binding("deepseek-v4-flash") }, maxRepairCycles: 2, requiredCleanCycles: 2 });
    expect(Object.values(profile.roles).map((role) => role.agentKind)).toEqual(["codex", "codex", "codex", "codex"]);
    expect(Object.values(profile.roles).filter((role) => role.filesystemAccess === "workspace_write"))
      .toEqual([profile.roles.implementer]);
    expect(makePiOnlyTeamProfile).toBe(makeCodexOnlyTeamProfile);
  });

  it("accepts DeepSeek V4 as a tool-capable writing implementer", () => {
    const profile = makeCodexOnlyTeamProfile({ roles: { explorer: binding("grok-4.3"),
      implementer: binding("deepseek-v4-flash"), tester: binding("grok-4.3"), reviewer: binding("grok-4.3") },
      maxRepairCycles: 1, requiredCleanCycles: 1 });
    expect(profile.roles.implementer.binding).toEqual(binding("deepseek-v4-flash"));
  });

  it("passes declared.binding.provider into makeCodexSubAgent in composeIssueTeamAgents", async () => {
    const profile = makeCodexOnlyTeamProfile({
      roles: {
        explorer: binding("deepseek-v4-flash"),
        implementer: binding("grok-4.3"),
        tester: binding("solar-pro4"),
        reviewer: binding("motif-3"),
      },
      maxRepairCycles: 1,
      requiredCleanCycles: 1,
    });
    let capturedArgs: readonly string[] = [];
    const spawnFn: SpawnFn = (_cmd, args) => {
      capturedArgs = args;
      return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as ChildProcess;
    };
    const agents = composeIssueTeamAgents(profile, {
      codex: {
        resolveBin: () => ({ command: "codex", prefixArgs: [] }),
        spawnFn,
        env: { NAIA_API_KEY: "test-key" },
      },
    });
    const explorer = agents[profile.roles.explorer.agentProfileId]!.adapter;
    const session = explorer.spawn({ prompt: "inspect", workdir: "." });
    await session.cancel("done");
    expect(capturedArgs).toContain('model_provider="naia"');
  });

  it("fails closed before opening state for a non-Naia or inactive binding", () => {
    const invalid = { stateDir: "/must-not-be-created", workspaceRoot: "/tmp", worktreeRoot: "/tmp",
      facing: { provider: "opencode", model: "grok-4.3" }, moderator: binding("grok-4.3"),
      reporter: binding("grok-4.3"), roles: { explorer: binding("grok-4.3"), implementer: binding("grok-4.3"),
        tester: binding("grok-4.3"), reviewer: binding("grok-4.3") }, profileId: "bad", maxRepairCycles: 1,
      requiredCleanCycles: 1, acceptanceChecks: [], concurrency: 1,
      budget: { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1, maxOutputTokens: 1 },
      callAllowance: { reservedUsd: 1, reservedInputTokens: 1, reservedOutputTokens: 1 } } as const;
    expect(() => makeCodexContinuousLoop(invalid)).toThrow(/active Naia or declared user-owned catalog/u);
  });

  it("accepts explicitly declared user-owned loopback bindings and built-in local bindings", () => {
    const localBinding = { provider: "local-vllm", model: "naia-0.9-coding-24g" } as const;
    const root = resolve(process.cwd()); const state = mkdtempSync(resolve(tmpdir(), "naia-local-loop-"));
    const config = { stateDir: state, workspaceRoot: root,
      worktreeRoot: resolve(state, "worktrees"), facing: localBinding,
      moderator: localBinding, reporter: localBinding, roles: { explorer: localBinding, implementer: localBinding,
        tester: localBinding, reviewer: localBinding }, profileId: "local", maxRepairCycles: 1,
      requiredCleanCycles: 1, acceptanceChecks: [{ name: "test", command: "true", args: [] }], concurrency: 1,
      budget: { maxPaidCalls: 20, maxUsd: 1, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
      callAllowance: { reservedUsd: 0.01, reservedInputTokens: 8_000, reservedOutputTokens: 1_000 },
      pi: { userOwnedProvider: { id: "local-vllm", baseUrl: "http://127.0.0.1:8000/v1",
        models: [{ id: "naia-0.9-coding-24g", contextWindow: 65_536, maxTokens: 4_096 }] } } } as const;
    const runtime = { makeSubAgent: () => ({ spawn: () => { throw new Error("not called during composition"); } }),
      worktrees: {} as never, verifier: {} as never };
    const loop = makePiContinuousLoop(config, runtime);
    try { expect(loop.profile.roles.implementer.binding).toEqual(localBinding); }
    finally { loop.close(); rmSync(state, { recursive: true, force: true }); }
  });

  it("accepts Codex Luna only as moderator while every other actor remains on the Naia Azure catalog", () => {
    const root = resolve(process.cwd()); const state = mkdtempSync(resolve(tmpdir(), "naia-hybrid-loop-"));
    const azure = binding("grok-4.3");
    const config = { stateDir: state, workspaceRoot: root, worktreeRoot: resolve(state, "worktrees"),
      facing: binding("deepseek-v4-flash"),
      moderator: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "high" },
      reporter: binding("deepseek-v4-flash"), roles: { explorer: azure, implementer: binding("grok-4.3"),
        tester: azure, reviewer: azure }, profileId: "codex-luna-azure-team", maxRepairCycles: 1,
      requiredCleanCycles: 2, acceptanceChecks: [{ name: "test", command: "true", args: [] }], concurrency: 1,
      budget: { maxPaidCalls: 20, maxUsd: 10, maxInputTokens: 1_000_000, maxOutputTokens: 100_000 },
      callAllowance: { reservedUsd: 0.25, reservedInputTokens: 50_000, reservedOutputTokens: 5_000 } } as const;
    const selected: Array<{ provider: string; model: string }> = [];
    const runtime = { makeSubAgent: (selectedBinding: { provider: string; model: string }) => {
      selected.push(selectedBinding); return { spawn: () => { throw new Error("not called during composition"); } };
    }, worktrees: {} as never, verifier: {} as never };
    const loop = makeCodexContinuousLoop(config, runtime);
    try {
      expect(selected.filter((item) => item.provider === "openai-codex"))
        .toEqual([{ provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "high" }]);
      expect(Object.values(loop.profile.roles).every((role) => role.binding.provider === "naia")).toBe(true);
    } finally { loop.close(); rmSync(state, { recursive: true, force: true }); }
  });

  it("rejects Codex outside the moderator slot and rejects non-Luna Codex moderators", () => {
    const base = { stateDir: "/must-not-be-created", workspaceRoot: "/tmp", worktreeRoot: "/tmp",
      facing: binding("deepseek-v4-flash"), moderator: binding("deepseek-v4-pro"),
      reporter: binding("deepseek-v4-flash"), roles: { explorer: binding("deepseek-v4-pro"),
        implementer: binding("grok-4.3"), tester: binding("deepseek-v4-pro"), reviewer: binding("deepseek-v4-pro") },
      profileId: "hybrid", maxRepairCycles: 1, requiredCleanCycles: 2, acceptanceChecks: [], concurrency: 1,
      budget: { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1, maxOutputTokens: 1 },
      callAllowance: { reservedUsd: 1, reservedInputTokens: 1, reservedOutputTokens: 1 } } as const;
    expect(() => makeCodexContinuousLoop({ ...base,
      facing: { provider: "openai-codex", model: "gpt-5.6-luna" } })).toThrow(/facing, reporter, and worker/u);
    expect(() => makeCodexContinuousLoop({ ...base,
      moderator: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" } }))
      .toThrow(/Codex gpt-5.6-luna/u);
  });

  it("has no OpenCode import, invocation, or fallback edge", () => {
    const entry = fileURLToPath(new URL("../main/composition/codex-continuous-loop.ts", import.meta.url));
    const pending = [entry]; const visited = new Set<string>();
    while (pending.length > 0) {
      const path = pending.pop()!; if (visited.has(path)) continue; visited.add(path);
      const source = readFileSync(path, "utf8");
      expect(`${path}\n${source}`).not.toMatch(/subagent-opencode|makeOpencode|composeIssueTeamAgents/u);
      for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/gu)) {
        pending.push(resolve(dirname(path), match[1]!.replace(/\.js$/u, ".ts")));
      }
    }
    expect(visited.size).toBeGreaterThan(10);
  });

  it("exposes a persistent NDJSON control session without claiming Discord or Shell ingress", () => {
    const source = readFileSync(new URL("../../bin/naia-agent-loop.mjs", import.meta.url), "utf8");
    const control = readFileSync(new URL("../main/composition/codex-continuous-loop-control.ts", import.meta.url), "utf8");
    expect(source).toContain("naia-agent loop serve");
    expect(source).toContain("createInterface({ input: process.stdin");
    expect(source).toContain("runCodexLoopControlSession");
    expect(source).toContain('["serve", "start", "answer", "cancel", "pump"]');
    expect(source).not.toContain(".pathname");
    expect(source).toContain("import(new URL(");
    expect(control).toContain("runCodexLoopControlSession");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:discord|shell)|import\([^)]*(?:discord|shell)/iu);
    expect(`${source}\n${control}`).not.toContain('command === "reconcile"');
  });
});
