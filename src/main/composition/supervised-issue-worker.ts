import { execFileSync } from "node:child_process";
import type { ActorReceipt, WorkerResult } from "../domain/issue-orchestration.js";
import { Supervisor } from "../app/supervisor.js";
import type { CodingJobWorktreePort } from "../ports/coding-job.js";
import { IssueActorResultError, type IssueWorkerPort } from "../ports/issue-orchestration.js";
import type { SubAgentPort, WorkspacePort } from "../ports/orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";

export interface SupervisedIssueWorkerOptions {
  readonly worktrees: CodingJobWorktreePort;
  readonly subAgent: SubAgentPort;
  readonly workspace?: WorkspacePort;
  readonly diag: DiagnosticLog;
  readonly nowMs?: () => number;
  readonly changedFiles?: (worktreePath: string) => readonly string[];
}

export function makeSupervisedIssueWorker(options: SupervisedIssueWorkerOptions): IssueWorkerPort {
  const completed = new Map<string, WorkerResult>();
  return {
    async execute(input): Promise<WorkerResult> {
      const prior = completed.get(input.dispatchId);
      if (prior) return prior;
      const startedAt = (options.nowMs ?? Date.now)();
      options.diag.debug?.("[SupervisedIssueWorker] execute", {
        at: startedAt, issueId: input.issueId, dispatchId: input.dispatchId, profileId: input.profileId,
      });
      const allocation = options.worktrees.allocate({ jobId: safeJobId(input.issueId), workspacePath: input.workspacePath });
      let report: import("../domain/orchestration.js").SupervisorReport | undefined;
      const supervisor = new Supervisor({
        subAgent: options.subAgent,
        ...(options.workspace ? { workspace: options.workspace } : {}),
        diag: options.diag,
        egress: { event() {}, report(value) { report = value; } },
      });
      try {
        await supervisor.run({
          prompt: workerPrompt(input.task, input.acceptanceChecks),
          workdir: allocation.worktreePath,
          model: input.binding.model,
          filesystemAccess: "workspace_write",
        }, input.signal);
      } finally {
        allocation.release();
      }
      const finishedAt = (options.nowMs ?? Date.now)();
      const evidence = report?.modelEvidence;
      const expectedBinding = input.binding;
      if (!evidence?.sessionId || !evidence.executionId || !evidence.provider || !evidence.selectedModel) throw new Error("worker receipt evidence unavailable");
      const receipt: ActorReceipt = {
        role: "worker",
        provider: evidence.provider,
        model: evidence.selectedModel,
        ...(evidence.reasoningEffort ? { reasoningEffort: evidence.reasoningEffort } : {}),
        sessionId: evidence.sessionId,
        executionId: evidence.executionId,
        idempotencyKey: input.dispatchId,
        tokenCountsAvailable: evidence.usageAvailable !== false,
        inputTokens: evidence?.inputTokens ?? 0,
        cachedInputTokens: evidence?.cachedInputTokens ?? 0,
        outputTokens: evidence?.outputTokens ?? 0,
        latencyMs: Math.max(0, finishedAt - startedAt),
        ...(evidence.modelEvidenceSource ? { modelEvidenceSource: evidence.modelEvidenceSource } : {}),
        cost: evidence?.measuredCostUsd !== undefined
          ? { state: "measured", usd: evidence.measuredCostUsd, source: "codex_usage_and_pinned_price" }
          : { state: "unavailable", reason: "worker adapter did not receive priced usage" },
      };
      if (evidence.provider !== expectedBinding.provider || evidence.selectedModel !== expectedBinding.model
        || evidence.reasoningEffort !== expectedBinding.reasoningEffort) {
        throw new IssueActorResultError("worker model binding mismatch", receipt);
      }
      const changedFiles = [...(options.changedFiles ?? gitChangedFiles)(allocation.worktreePath)].sort();
      const result: WorkerResult = {
        ok: Boolean(report?.sessionOk),
        summary: report ? `session=${report.sessionOk}; issue verification pending` : "supervisor emitted no report",
        worktreePath: allocation.worktreePath,
        changedFiles,
        receipt,
      };
      completed.set(input.dispatchId, result);
      return result;
    },
    async reconcile(dispatchId) { return completed.get(dispatchId); },
  };
}

function workerPrompt(task: string, checks: readonly string[]): string {
  return `${task}\n\nAcceptance checks (all required):\n${checks.map((check) => `- ${check}`).join("\n")}`;
}

function safeJobId(issueId: string): string {
  const normalized = issueId.replace(/[^A-Za-z0-9_-]/g, "-");
  return normalized.length >= 6 ? normalized.slice(0, 120) : `issue-${normalized.padEnd(6, "0")}`;
}

function gitChangedFiles(worktreePath: string): readonly string[] {
  try {
    return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
  } catch { return []; }
}
