import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteIssueOrchestrationStore } from "../main/adapters/sqlite-issue-orchestration-store.js";
import { SingleIssueOrchestrator } from "../main/app/single-issue-orchestrator.js";
import { groundedIssueCommentary, type ActorReceipt } from "../main/domain/issue-orchestration.js";
import { canonicalIssueTeamProfile, type IssueTeamProfile, type IssueTeamRole } from "../main/domain/issue-team.js";
import { IssueActorResultError } from "../main/ports/issue-orchestration.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function actor(role: ActorReceipt["role"], key: string, n: number, provider: string, model: string): ActorReceipt {
  return { role, provider, model, sessionId: `actor-session-${n}`, executionId: `actor-execution-${n}`, idempotencyKey: key,
    tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, latencyMs: 1,
    cost: { state: "measured", usd: 0.01, source: "fixture" } };
}
const team: IssueTeamProfile = { kind: "team", maxRepairCycles: 1, requiredCleanCycles: 1, roles: {
  explorer: declared("explorer", "codex", "read_only"), implementer: declared("implementer", "opencode", "workspace_write"),
  tester: declared("tester", "pi", "read_only"), reviewer: declared("reviewer", "codex", "read_only"),
} };
function declared(role: IssueTeamRole, agentKind: "codex" | "opencode" | "pi", filesystemAccess: "read_only" | "workspace_write") {
  return { agentProfileId: `${role}-profile`, agentKind, filesystemAccess, binding: { provider: `${agentKind}-provider`, model: `${agentKind}-model` } } as const;
}
function teamProjection() {
  return { profileId: "team", profileDigest: createHash("sha256").update(canonicalIssueTeamProfile(team), "utf8").digest("hex"), cleanCycles: 1, repairCycles: 0,
    outcomes: [
      { version: 1 as const, role: "explorer" as const, decision: "proceed" as const, summary: "explored", findings: [] },
      { version: 1 as const, role: "implementer" as const, decision: "implemented" as const, summary: "implemented", findings: [] },
      { version: 1 as const, role: "tester" as const, decision: "pass" as const, summary: "passed", findings: [] },
      { version: 1 as const, role: "reviewer" as const, decision: "clean" as const, summary: "clean", findings: [] },
    ] };
}

describe("REQ-023 parent issue verification boundary", () => {
  it("persists all team receipts but fails a clean team when the independent verifier fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-parent-")); roots.push(root);
    const store = new SqliteIssueOrchestrationStore(join(root, "issues.db")); let n = 0;
    const roleReceipts = (["explorer", "implementer", "tester", "reviewer"] as const).map((role, index) => {
      const selected = team.roles[role];
      return { ...actor("worker", `issue-1:dispatch:1:${role}:${index + 1}`, 10 + index, selected.binding.provider, selected.binding.model),
        workerRole: role, agentProfileId: selected.agentProfileId, agentKind: selected.agentKind };
    });
    const lead = roleReceipts[1]!;
    const orchestrator = new SingleIssueOrchestrator({ store, ids: () => "issue-1", now: () => "2026-08-02T00:00:00Z",
      facing: { async classify(input) { return { classification: { kind: "work", obligations: input.requiredObligations }, receipt: actor("naia", input.idempotencyKey, ++n, "naia", "luna") }; } },
      moderator: { async plan(input) { return { plan: { workerTask: "fix", workerProfile: "team", acceptanceChecks: ["real check"], questions: [] }, receipt: actor("moderator", input.idempotencyKey, ++n, "codex", "sol") }; } },
      worker: { async execute() { return { ok: true, summary: "clean", worktreePath: "/managed/team", changedFiles: ["src/fix.ts"], receipt: lead, receipts: roleReceipts,
        team: teamProjection() }; } },
      verifier: { async verify(input) { return { ok: false, checks: [{ name: "real check", pass: false }], receipt: actor("verifier", input.idempotencyKey, ++n, "verify", "deterministic") }; } },
      reporter: { async report(input) { const state = input.issue.state; return { report: { state, issueId: input.issue.issueId,
        summary: groundedIssueCommentary(input.issue, state), changedFiles: input.issue.worker?.changedFiles ?? [], verificationPassed: false },
        receipt: actor("reporter", input.idempotencyKey, ++n, "naia", "luna") }; } },
    });
    const report = await orchestrator.start({ requestId: "request-team", text: "fix", requiredObligations: ["fix"], workspacePath: "/repo",
      naiaBinding: { provider: "naia", model: "luna" }, moderatorBinding: { provider: "codex", model: "sol" }, workerProfiles: { team } });
    expect(report).toMatchObject({ state: "failed", verificationPassed: false, totalCost: { state: "measured", usd: 0.08 } });
    const snapshot = orchestrator.snapshot("issue-1");
    expect(snapshot.receipts.filter((item) => item.role === "worker")).toHaveLength(4);
    expect(snapshot.receipts.map((item) => item.workerRole).filter(Boolean)).toEqual(["explorer", "implementer", "tester", "reviewer"]);
    store.close();
  });

  it("preserves a paid team-role receipt when structured role output is rejected", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-rejected-")); roots.push(root);
    const store = new SqliteIssueOrchestrationStore(join(root, "issues.db")); let n = 0;
    const rejectedReceipts = (["explorer", "implementer", "tester"] as const).map((role, index) => { const selected = team.roles[role];
      return { ...actor("worker", `issue-1:dispatch:1:${role}:${index + 1}`, 20 + index, selected.binding.provider, selected.binding.model),
        workerRole: role, agentProfileId: selected.agentProfileId, agentKind: selected.agentKind }; });
    const rejected = rejectedReceipts[2]!;
    const orchestrator = new SingleIssueOrchestrator({ store, ids: () => "issue-1", now: () => "2026-08-02T00:00:00Z",
      facing: { async classify(input) { return { classification: { kind: "work", obligations: input.requiredObligations }, receipt: actor("naia", input.idempotencyKey, ++n, "naia", "luna") }; } },
      moderator: { async plan(input) { return { plan: { workerTask: "fix", workerProfile: "team", acceptanceChecks: ["check"], questions: [] }, receipt: actor("moderator", input.idempotencyKey, ++n, "codex", "sol") }; } },
      worker: { async execute() { throw new IssueActorResultError("malformed tester JSON", rejected, rejectedReceipts); } },
      verifier: { async verify() { throw new Error("must not verify"); } },
      reporter: { async report() { throw new Error("must not report"); } },
    });
    const report = await orchestrator.start({ requestId: "request-rejected", text: "fix", requiredObligations: ["fix"], workspacePath: "/repo",
      naiaBinding: { provider: "naia", model: "luna" }, moderatorBinding: { provider: "codex", model: "sol" }, workerProfiles: { team } });
    expect(report).toMatchObject({ state: "failed", totalCost: { state: "measured", usd: 0.05 } });
    expect(orchestrator.snapshot("issue-1").receipts.filter((item) => item.role === "worker").map((item) => item.workerRole))
      .toEqual(["explorer", "implementer", "tester"]);
    store.close();
  });

  it("rejects a team aggregate whose legacy lead receipt is not the implementer", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-lead-")); roots.push(root);
    const store = new SqliteIssueOrchestrationStore(join(root, "issues.db")); let n = 0;
    const receipts = (["explorer", "implementer", "tester", "reviewer"] as const).map((role, index) => {
      const selected = team.roles[role]; return { ...actor("worker", `issue-1:dispatch:1:${role}:${index + 1}`, 30 + index, selected.binding.provider, selected.binding.model),
        workerRole: role, agentProfileId: selected.agentProfileId, agentKind: selected.agentKind };
    });
    const orchestrator = new SingleIssueOrchestrator({ store, ids: () => "issue-1", now: () => "2026-08-02T00:00:00Z",
      facing: { async classify(input) { return { classification: { kind: "work", obligations: input.requiredObligations }, receipt: actor("naia", input.idempotencyKey, ++n, "naia", "luna") }; } },
      moderator: { async plan(input) { return { plan: { workerTask: "fix", workerProfile: "team", acceptanceChecks: ["check"], questions: [] }, receipt: actor("moderator", input.idempotencyKey, ++n, "codex", "sol") }; } },
      worker: { async execute() { return { ok: true, summary: "invalid lead", worktreePath: "/managed/team", changedFiles: [], receipt: receipts[0]!, receipts,
        team: teamProjection() }; } },
      verifier: { async verify() { throw new Error("must not verify"); } }, reporter: { async report() { throw new Error("must not report"); } },
    });
    const report = await orchestrator.start({ requestId: "request-lead", text: "fix", requiredObligations: ["fix"], workspacePath: "/repo",
      naiaBinding: { provider: "naia", model: "luna" }, moderatorBinding: { provider: "codex", model: "sol" }, workerProfiles: { team } });
    expect(report.state).toBe("outcome_unknown");
    expect(orchestrator.snapshot("issue-1").receipts.filter((item) => item.role === "worker")).toHaveLength(0);
    store.close();
  });

  it("rejects a successful team aggregate when its bounded projection is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-team-projection-")); roots.push(root);
    const store = new SqliteIssueOrchestrationStore(join(root, "issues.db")); let n = 0;
    const receipts = (["explorer", "implementer", "tester", "reviewer"] as const).map((role, index) => {
      const selected = team.roles[role]; return { ...actor("worker", `issue-1:dispatch:1:${role}:${index + 1}`, 40 + index, selected.binding.provider, selected.binding.model),
        workerRole: role, agentProfileId: selected.agentProfileId, agentKind: selected.agentKind };
    });
    const orchestrator = new SingleIssueOrchestrator({ store, ids: () => "issue-1", now: () => "2026-08-02T00:00:00Z",
      facing: { async classify(input) { return { classification: { kind: "work", obligations: input.requiredObligations }, receipt: actor("naia", input.idempotencyKey, ++n, "naia", "luna") }; } },
      moderator: { async plan(input) { return { plan: { workerTask: "fix", workerProfile: "team", acceptanceChecks: ["check"], questions: [] }, receipt: actor("moderator", input.idempotencyKey, ++n, "codex", "sol") }; } },
      worker: { async execute() { return { ok: true, summary: "invalid projection", worktreePath: "/managed/team", changedFiles: [], receipt: receipts[1]!, receipts }; } },
      verifier: { async verify() { throw new Error("must not verify"); } }, reporter: { async report() { throw new Error("must not report"); } },
    });
    const report = await orchestrator.start({ requestId: "request-projection", text: "fix", requiredObligations: ["fix"], workspacePath: "/repo",
      naiaBinding: { provider: "naia", model: "luna" }, moderatorBinding: { provider: "codex", model: "sol" }, workerProfiles: { team } });
    expect(report.state).toBe("outcome_unknown");
    expect(orchestrator.snapshot("issue-1").receipts.filter((item) => item.role === "worker")).toHaveLength(0);
    store.close();
  });
});
