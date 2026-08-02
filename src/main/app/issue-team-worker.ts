import { createHash } from "node:crypto";
import type { ActorReceipt, WorkerResult } from "../domain/issue-orchestration.js";
import {
  assertIssueTeamProfile, canonicalIssueTeamProfile, isIssueTeamProfile, type IssueTeamProfile, type IssueTeamRole,
  type IssueTeamRoleResult, type IssueTeamRunSnapshot,
} from "../domain/issue-team.js";
import type { CodingJobAllocation, CodingJobWorktreePort } from "../ports/coding-job.js";
import type { IssueTeamRoleExecutorPort, IssueTeamStore } from "../ports/issue-team.js";
import { IssueActorResultError, type IssueWorkerPort } from "../ports/issue-orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";

export interface IssueTeamWorkerOptions {
  readonly store: IssueTeamStore;
  readonly worktrees: CodingJobWorktreePort;
  readonly roles: IssueTeamRoleExecutorPort;
  readonly diag?: DiagnosticLog;
  readonly changedFiles?: (path: string) => readonly string[];
}

export function makeIssueTeamWorker(options: IssueTeamWorkerOptions): IssueWorkerPort {
  const run = async (input: Parameters<IssueWorkerPort["execute"]>[0], recovery: boolean): Promise<WorkerResult | undefined> => {
    if (!input.profile || !isIssueTeamProfile(input.profile)) throw new Error("issue-team profile is required");
    const profile = input.profile;
    assertIssueTeamProfile(profile);
    const profileDigest = digest(canonicalIssueTeamProfile(profile));
    const fingerprint = digest(stableJson({ issueId: input.issueId, workspacePath: input.workspacePath, task: input.task,
      obligations: input.obligations, acceptanceChecks: input.acceptanceChecks, profileId: input.profileId, profileDigest }));
    let allocation: CodingJobAllocation | undefined;
    let snapshot = options.store.get(input.dispatchId);
    if (!snapshot) {
      allocation = options.worktrees.allocate({ jobId: safeJobId(input.issueId), workspacePath: input.workspacePath });
      snapshot = options.store.createOrGet({
        version: 1, dispatchId: input.dispatchId, fingerprint, issueId: input.issueId, profileId: input.profileId,
        profileDigest, state: "ready", nextRole: "explorer", attemptNo: 0,
        allocation: { workspacePath: allocation.workspacePath, worktreePath: allocation.worktreePath,
          branch: allocation.branch, leaseId: allocation.leaseId },
        cleanCycles: 0, repairCycles: 0, outcomes: [], receipts: [],
      }).snapshot;
    } else if (snapshot.fingerprint !== fingerprint) throw new Error("team dispatch fingerprint mismatch");
    if (snapshot.state === "completed" || snapshot.state === "failed") return snapshot.result;
    if (snapshot.state === "running") return recovery ? undefined : Promise.reject(new Error("team role outcome is unknown"));
    if (recovery) {
      const recovered = options.worktrees.recover?.({ jobId: safeJobId(input.issueId), workspacePath: snapshot.allocation.workspacePath,
        worktreePath: snapshot.allocation.worktreePath, leaseId: snapshot.allocation.leaseId });
      if (recovered !== true) return undefined;
    }
    try {
      for (;;) {
        const role = snapshot.nextRole;
        const attemptNo = snapshot.attemptNo + 1;
        const stepId = `${input.dispatchId}:${role}:${attemptNo}`;
        snapshot = options.store.save({ expectedVersion: snapshot.version, eventType: "role_claimed", snapshot: {
          ...snapshot, state: "running", activeStepId: stepId, attemptNo,
        } });
        options.diag?.debug?.("[IssueTeamWorker] role-claimed", { issueId: input.issueId, dispatchId: input.dispatchId, role, attemptNo });
        const executed = await options.roles.execute({ issueId: input.issueId, dispatchId: input.dispatchId, stepId,
          worktreePath: snapshot.allocation.worktreePath, task: input.task, context: roleContext(input, snapshot),
          roleProfile: profile.roles[role], signal: input.signal });
        assertRoleReceipt(executed.receipt, stepId, role, profile);
        assertDistinct(snapshot.receipts, executed.receipt);
        try { assertRoleResult(executed.result, role); }
        catch { throw new IssueActorResultError("issue-team role result rejected", executed.receipt); }
        const outcomes = [...snapshot.outcomes, executed.result];
        const receipts = [...snapshot.receipts, executed.receipt];
        const transition = nextTransition(role, executed.result, snapshot.cleanCycles, snapshot.repairCycles, profile);
        if (transition.terminal) {
          const lead = receipts.find((receipt) => receipt.workerRole === "implementer");
          if (!lead) throw new Error("team completed without an implementer receipt");
          const result: WorkerResult = {
            ok: transition.ok, summary: transition.ok ? "issue team converged; issue verification pending" : "issue team exhausted its repair bound",
            worktreePath: snapshot.allocation.worktreePath,
            changedFiles: [...(options.changedFiles?.(snapshot.allocation.worktreePath) ?? [])].sort(),
            receipt: lead, receipts,
            team: { profileId: input.profileId, profileDigest, cleanCycles: transition.cleanCycles,
              repairCycles: transition.repairCycles, outcomes },
          };
          snapshot = options.store.save({ expectedVersion: snapshot.version, eventType: transition.ok ? "team_completed" : "team_failed", snapshot: {
            ...snapshot, state: transition.ok ? "completed" : "failed", activeStepId: undefined,
            cleanCycles: transition.cleanCycles, repairCycles: transition.repairCycles, outcomes, receipts, result,
          } });
          allocation?.release();
          return snapshot.result;
        }
        snapshot = options.store.save({ expectedVersion: snapshot.version, eventType: "role_acknowledged", snapshot: {
          ...snapshot, state: "ready", activeStepId: undefined, nextRole: transition.nextRole,
          cleanCycles: transition.cleanCycles, repairCycles: transition.repairCycles, outcomes, receipts,
        } });
      }
    } catch (error) {
      if (error instanceof IssueActorResultError && snapshot.state === "running" && snapshot.activeStepId) {
        try {
          assertRoleReceipt(error.receipt, snapshot.activeStepId, snapshot.nextRole, profile);
          assertDistinct(snapshot.receipts, error.receipt);
          snapshot = options.store.save({ expectedVersion: snapshot.version, eventType: "role_failed", snapshot: {
            ...snapshot, state: "failed", activeStepId: undefined, receipts: [...snapshot.receipts, error.receipt],
          } });
        } catch { /* Invalid or concurrently changed evidence stays running/unknown. */ }
      }
      allocation?.release();
      throw error;
    }
  };
  return {
    async execute(input) { const result = await run(input, false); if (!result) throw new Error("team result unavailable"); return result; },
    async recover(input) { return run(input, true); },
    async reconcile(dispatchId) { const snapshot = options.store.get(dispatchId); return snapshot?.result; },
  };
}

function nextTransition(role: IssueTeamRole, result: IssueTeamRoleResult, clean: number, repairs: number, profile: IssueTeamProfile):
  { readonly terminal: false; readonly nextRole: IssueTeamRole; readonly cleanCycles: number; readonly repairCycles: number }
  | { readonly terminal: true; readonly ok: boolean; readonly cleanCycles: number; readonly repairCycles: number } {
  if (role === "explorer") return { terminal: false, nextRole: "implementer", cleanCycles: 0, repairCycles: repairs };
  if (role === "implementer") return { terminal: false, nextRole: "tester", cleanCycles: 0, repairCycles: repairs };
  if (role === "tester") {
    if (result.decision === "pass") return { terminal: false, nextRole: "reviewer", cleanCycles: clean, repairCycles: repairs };
    if (repairs >= profile.maxRepairCycles) return { terminal: true, ok: false, cleanCycles: 0, repairCycles: repairs };
    return { terminal: false, nextRole: "implementer", cleanCycles: 0, repairCycles: repairs + 1 };
  }
  if (result.decision === "changes_requested") {
    if (repairs >= profile.maxRepairCycles) return { terminal: true, ok: false, cleanCycles: 0, repairCycles: repairs };
    return { terminal: false, nextRole: "implementer", cleanCycles: 0, repairCycles: repairs + 1 };
  }
  const nextClean = clean + 1;
  return nextClean >= profile.requiredCleanCycles
    ? { terminal: true, ok: true, cleanCycles: nextClean, repairCycles: repairs }
    : { terminal: false, nextRole: "tester", cleanCycles: nextClean, repairCycles: repairs };
}

function assertRoleResult(result: IssueTeamRoleResult, role: IssueTeamRole): void {
  const decisions: Record<IssueTeamRole, readonly string[]> = { explorer: ["proceed"], implementer: ["implemented"], tester: ["pass", "fail"], reviewer: ["clean", "changes_requested"] };
  if (result.version !== 1 || result.role !== role || !decisions[role].includes(result.decision)
    || Buffer.byteLength(result.summary, "utf8") > 8 * 1024 || result.findings.length > 32
    || Object.keys(result).some((key) => !["version", "role", "decision", "summary", "findings"].includes(key))) throw new Error("invalid issue-team role result");
  const codes = new Set<string>();
  for (const finding of result.findings) {
    if (!finding.code || finding.code.length > 80 || Buffer.byteLength(finding.message, "utf8") > 2 * 1024
      || Object.keys(finding).some((key) => !["code", "message"].includes(key)) || codes.has(finding.code)) throw new Error("invalid issue-team finding");
    codes.add(finding.code);
  }
}

function assertRoleReceipt(receipt: ActorReceipt, stepId: string, role: IssueTeamRole, profile: IssueTeamProfile): void {
  const declared = profile.roles[role];
  if (receipt.role !== "worker" || receipt.workerRole !== role || receipt.agentProfileId !== declared.agentProfileId
    || receipt.agentKind !== declared.agentKind || receipt.idempotencyKey !== stepId || receipt.provider !== declared.binding.provider
    || receipt.model !== declared.binding.model || (declared.binding.reasoningEffort !== undefined && receipt.reasoningEffort !== declared.binding.reasoningEffort)
    || !receipt.sessionId || !receipt.executionId) throw new Error("issue-team role receipt mismatch");
}
function assertDistinct(prior: readonly ActorReceipt[], next: ActorReceipt): void {
  if (prior.some((receipt) => receipt.sessionId === next.sessionId || receipt.executionId === next.executionId || receipt.idempotencyKey === next.idempotencyKey)) throw new Error("duplicate issue-team receipt identity");
}
function roleContext(input: Parameters<IssueWorkerPort["execute"]>[0], snapshot: IssueTeamRunSnapshot): string {
  const base = { obligations: input.obligations, acceptanceChecks: input.acceptanceChecks };
  if (Buffer.byteLength(JSON.stringify(base), "utf8") > 64 * 1024) throw new Error("issue-team input context exceeded 64 KiB");
  const priorOutcomes: IssueTeamRoleResult[] = [];
  for (let index = snapshot.outcomes.length - 1; index >= 0; index -= 1) {
    const candidate = [snapshot.outcomes[index]!, ...priorOutcomes];
    if (Buffer.byteLength(JSON.stringify({ ...base, priorOutcomes: candidate }), "utf8") > 64 * 1024) break;
    priorOutcomes.unshift(snapshot.outcomes[index]!);
  }
  return JSON.stringify({ ...base, priorOutcomes });
}
function safeJobId(issueId: string): string { const value = issueId.replace(/[^A-Za-z0-9_-]/gu, "-"); return value.length >= 6 ? value.slice(0, 120) : `issue-${value.padEnd(6, "0")}`; }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`; return JSON.stringify(value); }
