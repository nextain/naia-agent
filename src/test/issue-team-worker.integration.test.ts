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

  it("releases a losing allocation when a stale first-read races an existing dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-")); roots.push(root);
    const durable = new SqliteIssueTeamStore(join(root, "team.db"));
    let resolve!: () => void; const gate = new Promise<void>((done) => { resolve = done; });
    let allocations = 0; const released: number[] = [];
    const worktrees = { allocate() { const id = ++allocations; return { workspacePath: "/repo", worktreePath: `/managed/team-${id}`,
      branch: `naia/team-${id}`, leaseId: `lease-${id}`, release() { released.push(id); } }; } };
    const first = makeIssueTeamWorker({ store: durable, worktrees, roles: { async execute(value) { await gate;
      return { result: result("explorer", "proceed"), receipt: receipt("explorer", value.stepId, 1) }; } } });
    const active = first.execute(input());
    await new Promise((done) => setTimeout(done, 5));
    let stale = true;
    const staleStore: IssueTeamStore = { createOrGet: (snapshot) => durable.createOrGet(snapshot),
      get(dispatchId) { if (stale) { stale = false; return undefined; } return durable.get(dispatchId); },
      save: (value) => durable.save(value), close() {} };
    const duplicate = makeIssueTeamWorker({ store: staleStore, worktrees,
      roles: { async execute() { throw new Error("duplicate must not dispatch"); } } });
    await expect(duplicate.execute(input())).rejects.toThrow("outcome is unknown");
    expect(released).toEqual([2]);
    resolve(); await expect(active).rejects.toThrow();
    expect(released).toContain(1);
    durable.close();
  });

  it("releases a new allocation when durable dispatch creation conflicts", async () => {
    let releases = 0;
    const conflicting: IssueTeamStore = { get: () => undefined, createOrGet() { throw new Error("team dispatch fingerprint mismatch"); },
      save() { throw new Error("must not save"); }, close() {} };
    const worker = makeIssueTeamWorker({ store: conflicting, worktrees: { allocate() { return { workspacePath: "/repo", worktreePath: "/managed/team",
      branch: "naia/team", leaseId: "lease", release() { releases += 1; } }; } }, roles: { async execute() { throw new Error("must not execute"); } } });
    await expect(worker.execute(input())).rejects.toThrow("fingerprint mismatch");
    expect(releases).toBe(1);
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

  it("rejects non-string finding fields and exposes all prior paid receipts to the parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-")); roots.push(root);
    const store = new SqliteIssueTeamStore(join(root, "team.db")); let n = 0;
    const worker = makeIssueTeamWorker({ store, worktrees: { allocate() { return { workspacePath: "/repo", worktreePath: "/managed/team", branch: "naia/team", leaseId: "lease", release() {} }; } },
      roles: { async execute(value) { const role = (["explorer", "implementer", "tester"] as const)[n]!; n += 1;
        const valid = role === "explorer" ? result(role, "proceed") : role === "implementer" ? result(role, "implemented")
          : { version: 1, role, decision: "fail", summary: "bad finding", findings: [{ code: 7, message: "numeric" }] } as unknown as IssueTeamRoleResult;
        return { result: valid, receipt: receipt(role, value.stepId, n) }; } } });
    const error = await worker.execute(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ receipts: [{ workerRole: "explorer" }, { workerRole: "implementer" }, { workerRole: "tester" }] });
    expect(store.get(input().dispatchId)?.receipts).toHaveLength(3);
    store.close();
  });
});
