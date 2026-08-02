import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeIssueTeamWorker } from "../main/app/issue-team-worker.js";
import { SqliteIssueTeamStore } from "../main/adapters/sqlite-issue-team-store.js";
import type { ActorReceipt } from "../main/domain/issue-orchestration.js";
import type { IssueTeamProfile, IssueTeamRole, IssueTeamRoleResult } from "../main/domain/issue-team.js";
import type { IssueTeamStore } from "../main/ports/issue-team.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const profile: IssueTeamProfile = {
  kind: "team", maxRepairCycles: 2, requiredCleanCycles: 2,
  roles: {
    explorer: roleProfile("explorer", "codex", "read_only"),
    implementer: roleProfile("implementer", "opencode", "workspace_write"),
    tester: roleProfile("tester", "pi", "read_only"),
    reviewer: roleProfile("reviewer", "codex", "read_only"),
  },
};
function roleProfile(role: IssueTeamRole, agentKind: "codex" | "opencode" | "pi", filesystemAccess: "read_only" | "workspace_write") {
  return { agentProfileId: `${role}-profile`, agentKind, filesystemAccess, binding: { provider: `${agentKind}-provider`, model: `${agentKind}-model` } } as const;
}
function result(role: IssueTeamRole, decision: IssueTeamRoleResult["decision"], code?: string): IssueTeamRoleResult {
  return { version: 1, role, decision, summary: `${role}:${decision}`, findings: code ? [{ code, message: code }] : [] };
}
function receipt(role: IssueTeamRole, stepId: string, n: number): ActorReceipt {
  const declared = profile.roles[role];
  return { role: "worker", workerRole: role, agentProfileId: declared.agentProfileId, agentKind: declared.agentKind,
    provider: declared.binding.provider, model: declared.binding.model, sessionId: `session-${n}`, executionId: `execution-${n}`,
    idempotencyKey: stepId, tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 2, outputTokens: 4,
    latencyMs: 5, cost: { state: "measured", usd: 0.001, source: "fixture" } };
}
function input() { return { issueId: "issue-team-1", dispatchId: "issue-team-1:dispatch:1", workspacePath: "/repo", task: "fix parser",
  obligations: ["fix parser"], profileId: "team-balanced", profile, acceptanceChecks: ["tests pass"], signal: new AbortController().signal }; }

describe("REQ-023 durable issue-team worker", () => {
  it("repairs findings, requires two clean cycles, and returns every distinct role receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-")); roots.push(root);
    const store = new SqliteIssueTeamStore(join(root, "team.db"));
    const planned = [result("explorer", "proceed"), result("implementer", "implemented"), result("tester", "fail", "T1"),
      result("implementer", "implemented"), result("tester", "pass"), result("reviewer", "clean"),
      result("tester", "pass"), result("reviewer", "clean")];
    const seen: Array<{ role: IssueTeamRole; access: string; context: string }> = [];
    let n = 0; let allocations = 0;
    const worker = makeIssueTeamWorker({ store, worktrees: { allocate() { allocations += 1; return { workspacePath: "/repo", worktreePath: "/managed/team", branch: "naia/team", leaseId: "lease-1", release() {} }; } },
      roles: { async execute(value) { const next = planned[n]!; seen.push({ role: next.role, access: value.roleProfile.filesystemAccess, context: value.context }); n += 1; return { result: next, receipt: receipt(next.role, value.stepId, n) }; } },
      changedFiles: () => ["src/parser.ts"] });
    const completed = await worker.execute(input());
    const duplicate = await worker.execute(input());
    expect(duplicate).toEqual(completed);
    expect(allocations).toBe(1);
    expect(seen.map((item) => item.role)).toEqual(["explorer", "implementer", "tester", "implementer", "tester", "reviewer", "tester", "reviewer"]);
    expect(seen.filter((item) => item.access === "workspace_write").map((item) => item.role)).toEqual(["implementer", "implementer"]);
    expect(seen[3]?.context).toContain("T1");
    expect(completed).toMatchObject({ ok: true, changedFiles: ["src/parser.ts"], team: { cleanCycles: 2, repairCycles: 1 } });
    expect(completed.receipts).toHaveLength(8);
    expect(new Set(completed.receipts?.map((item) => item.sessionId)).size).toBe(8);
    store.close();
  });

  it("returns unknown instead of replaying a durably claimed in-flight role", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-")); roots.push(root);
    const store = new SqliteIssueTeamStore(join(root, "team.db"));
    let resolve!: () => void; const gate = new Promise<void>((done) => { resolve = done; });
    const worktrees = { allocate() { return { workspacePath: "/repo", worktreePath: "/managed/team", branch: "naia/team", leaseId: "lease-1", release() {} }; } };
    const first = makeIssueTeamWorker({ store, worktrees, roles: { async execute(value) { await gate; return { result: result("explorer", "proceed"), receipt: receipt("explorer", value.stepId, 1) }; } } });
    const active = first.execute(input());
    await new Promise((done) => setTimeout(done, 5));
    const reopened = makeIssueTeamWorker({ store, worktrees, roles: { async execute() { throw new Error("must not replay"); } } });
    expect(await reopened.recover?.(input())).toBeUndefined();
    resolve(); await expect(active).rejects.toThrow();
    store.close();
  });

  it("fails closed when a ready restart cannot recover its managed worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-")); roots.push(root);
    const durable = new SqliteIssueTeamStore(join(root, "team.db"));
    const crashAfterAcknowledge: IssueTeamStore = {
      createOrGet: (snapshot) => durable.createOrGet(snapshot),
      get: (dispatchId) => durable.get(dispatchId),
      save(value) {
        const saved = durable.save(value);
        if (value.eventType === "role_acknowledged") throw new Error("simulated process crash");
        return saved;
      },
      close: () => durable.close(),
    };
    const allocation = { workspacePath: "/repo", worktreePath: "/managed/team", branch: "naia/team", leaseId: "lease-1", release() {} };
    const first = makeIssueTeamWorker({ store: crashAfterAcknowledge, worktrees: { allocate: () => allocation },
      roles: { async execute(value) { return { result: result("explorer", "proceed"), receipt: receipt("explorer", value.stepId, 1) }; } } });
    await expect(first.execute(input())).rejects.toThrow("simulated process crash");
    expect(durable.get(input().dispatchId)).toMatchObject({ state: "ready", nextRole: "implementer" });
    let roleCalls = 0; let recoverCalls = 0;
    const reopened = makeIssueTeamWorker({ store: durable, worktrees: { allocate: () => allocation, recover() { recoverCalls += 1; return false; } },
      roles: { async execute() { roleCalls += 1; throw new Error("must not dispatch without a recovered worktree"); } } });
    expect(await reopened.recover?.(input())).toBeUndefined();
    expect(recoverCalls).toBe(1);
    expect(roleCalls).toBe(0);
    expect(durable.get(input().dispatchId)).toMatchObject({ state: "ready", nextRole: "implementer" });
    durable.close();
  });

  it("rejects malformed profiles and role/decision drift before acknowledging a result", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-")); roots.push(root);
    const store = new SqliteIssueTeamStore(join(root, "team.db"));
    const bad = { ...profile, roles: { ...profile.roles, explorer: { ...profile.roles.explorer, filesystemAccess: "workspace_write" as const } } };
    const worker = makeIssueTeamWorker({ store, worktrees: { allocate() { return { workspacePath: "/repo", worktreePath: "/managed/team", branch: "naia/team", leaseId: "lease", release() {} }; } },
      roles: { async execute(value) { return { result: result("tester", "pass"), receipt: receipt("explorer", value.stepId, 1) }; } } });
    await expect(worker.execute({ ...input(), profile: bad })).rejects.toThrow("filesystem access");
    await expect(worker.execute(input())).rejects.toThrow("role result");
    expect(store.get(input().dispatchId)).toMatchObject({ state: "failed", receipts: [{ workerRole: "explorer" }] });
    store.close();
  });
});
