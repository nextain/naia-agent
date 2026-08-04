import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makePiContinuousLoop, makePiOnlyTeamProfile } from "../main/composition/pi-continuous-loop.js";

const binding = (model: string) => ({ provider: "naia", model });

describe("Pi-only continuous loop contract", () => {
  it("pins all authored team roles to built-in Pi with one writing role", () => {
    const profile = makePiOnlyTeamProfile({ roles: { explorer: binding("deepseek-v4-pro"),
      implementer: binding("grok-4.3"), tester: binding("deepseek-v4-pro"),
      reviewer: binding("deepseek-v4-pro") }, maxRepairCycles: 2, requiredCleanCycles: 2 });
    expect(Object.values(profile.roles).map((role) => role.agentKind)).toEqual(["pi", "pi", "pi", "pi"]);
    expect(Object.values(profile.roles).filter((role) => role.filesystemAccess === "workspace_write"))
      .toEqual([profile.roles.implementer]);
  });

  it("rejects an analysis-only model as implementer", () => {
    expect(() => makePiOnlyTeamProfile({ roles: { explorer: binding("grok-4.3"),
      implementer: binding("deepseek-v4-pro"), tester: binding("grok-4.3"), reviewer: binding("grok-4.3") },
      maxRepairCycles: 1, requiredCleanCycles: 1 })).toThrow(/analysis-only/u);
  });

  it("fails closed before opening state for a non-Naia or inactive Pi binding", () => {
    const invalid = { stateDir: "/must-not-be-created", workspaceRoot: "/tmp", worktreeRoot: "/tmp",
      facing: { provider: "opencode", model: "grok-4.3" }, moderator: binding("grok-4.3"),
      reporter: binding("grok-4.3"), roles: { explorer: binding("grok-4.3"), implementer: binding("grok-4.3"),
        tester: binding("grok-4.3"), reviewer: binding("grok-4.3") }, profileId: "bad", maxRepairCycles: 1,
      requiredCleanCycles: 1, acceptanceChecks: [], concurrency: 1,
      budget: { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1, maxOutputTokens: 1 },
      callAllowance: { reservedUsd: 1, reservedInputTokens: 1, reservedOutputTokens: 1 } } as const;
    expect(() => makePiContinuousLoop(invalid)).toThrow(/active Naia Pi catalog/u);
  });

  it("has no OpenCode import, invocation, or fallback edge", () => {
    const entry = new URL("../main/composition/pi-continuous-loop.ts", import.meta.url).pathname;
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
    const control = readFileSync(new URL("../main/composition/pi-continuous-loop-control.ts", import.meta.url), "utf8");
    expect(source).toContain("naia-agent loop serve");
    expect(source).toContain("createInterface({ input: process.stdin");
    expect(source).toContain("runPiLoopControlSession");
    expect(source).toContain('["serve", "start", "answer", "cancel", "pump"]');
    expect(source).not.toContain(".pathname");
    expect(source).toContain("import(new URL(");
    expect(control).toContain("runPiLoopControlSession");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:discord|shell)|import\([^)]*(?:discord|shell)/iu);
    expect(`${source}\n${control}`).not.toContain('command === "reconcile"');
    const live = readFileSync(new URL("../../benchmark/run-pi-continuous-loop-live.mjs", import.meta.url), "utf8");
    expect(live).not.toContain(".pathname");
    expect(live).toContain("import(new URL(");
    expect(live).toContain("durable --output path is required for paid smoke");
    expect(live).toContain("initializeGatewayRequestBudget");
    expect(live).toContain('status: "unavailable"');
    expect(live).not.toContain("rmSync(root");
    const guardedSetup = live.indexOf("try {", live.indexOf("let budget; let billing"));
    expect(guardedSetup).toBeGreaterThan(0);
    expect(live.indexOf('await import(new URL("adapters/subagent-pi.js"', guardedSetup)).toBeGreaterThan(guardedSetup);
    expect(live.indexOf("initializeGatewayRequestBudget", guardedSetup)).toBeGreaterThan(guardedSetup);
  });
});
