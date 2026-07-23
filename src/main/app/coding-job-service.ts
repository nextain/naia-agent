import { randomUUID } from "node:crypto";
import {
  CodingJobNotFoundError,
  CodingJobResumeUnavailableError,
  type CodingJob,
} from "../domain/coding-job.js";
import { codingJobCourseLifecycleState, isCodingJobTerminal, transitionCodingJob } from "../domain/coding-job.js";
import type { CodingJobAllocation, CodingJobControlPort, CodingJobCourseLifecyclePort, CodingJobRunnerPort, CodingJobStore, CodingJobWorktreePort, SelectedWorkspaceCodingPort } from "../ports/coding-job.js";
export { CodingJobNotFoundError, CodingJobResumeUnavailableError } from "../domain/coding-job.js";

export interface CodingJobServiceDeps {
  readonly store: CodingJobStore;
  readonly worktrees: CodingJobWorktreePort;
  readonly runner: CodingJobRunnerPort;
  readonly selectedWorkspace?: SelectedWorkspaceCodingPort;
  readonly courseLifecycle?: CodingJobCourseLifecyclePort;
  readonly now?: () => string;
  readonly ids?: () => string;
}

export class CodingJobService implements CodingJobControlPort {
  readonly #active = new Map<string, { allocation: CodingJobAllocation; cancel: (reason: string) => Promise<void> }>();
  readonly #now: () => string;
  readonly #ids: () => string;
  constructor(private readonly d: CodingJobServiceDeps) {
    this.#now = d.now ?? (() => new Date().toISOString());
    this.#ids = d.ids ?? randomUUID;
    this.#recoverInterruptedJobs();
  }

  start(input: { workspacePath: string; task: string; model?: string; executionMode?: "isolated_worktree" | "selected_workspace"; allowedFiles?: readonly string[]; courseReply?: import("../domain/coding-job.js").CodingJobCourseReply }): CodingJob {
    if (!input.task.trim()) throw new Error("coding job task is required");
    const executionMode = input.executionMode ?? "isolated_worktree";
    if (executionMode === "selected_workspace" && (!input.allowedFiles?.length || !this.d.selectedWorkspace)) throw new Error("selected workspace mode is unavailable");
    const jobId = this.#ids();
    const allocation = executionMode === "selected_workspace"
      ? this.d.selectedWorkspace!.prepare({ jobId, workspacePath: input.workspacePath, allowedFiles: input.allowedFiles! })
      : this.d.worktrees.allocate({ jobId, workspacePath: input.workspacePath });
    const now = this.#now();
    let job: CodingJob = {
      jobId, workspacePath: allocation.workspacePath, worktreePath: allocation.worktreePath,
      branch: allocation.branch, leaseId: allocation.leaseId, task: input.task, ...(input.model ? { model: input.model } : {}),
      state: "queued", executionMode, ...(executionMode === "selected_workspace" ? { allowedFiles: [...input.allowedFiles!] } : {}), ...(input.courseReply ? { courseReply: input.courseReply } : {}), createdAt: now, updatedAt: now,
    };
    this.d.store.save(job);
    this.#reportCourseLifecycle(job);
    try {
      let cancel = async (_reason: string): Promise<void> => {};
      this.#active.set(jobId, { allocation, cancel: (reason) => cancel(reason) });
      // Runners are provider-neutral and may synchronously call terminal()
      // while start() is still on the stack. Persist running before handing
      // them the callback so a terminal transition cannot be overwritten by a
      // stale queued object after start() returns.
      job = transitionCodingJob(job, "running", this.#now());
      this.d.store.save(job);
      this.#reportCourseLifecycle(job);
      const run = this.d.runner.start({ job, terminal: (result) => this.#terminal(jobId, result.ok, result.reason, result.patch, result.releaseLease) });
      cancel = (reason) => run.cancel(reason);
      return this.d.store.get(jobId) ?? job;
    } catch (error) {
      const current = this.d.store.get(jobId) ?? job;
      if (isCodingJobTerminal(current.state)) return current;
      const failed = transitionCodingJob(current, "failed", this.#now(), error instanceof Error ? error.message : String(error));
      this.d.store.save(failed); this.#reportCourseLifecycle(failed); this.#active.delete(jobId); allocation.release();
      return failed;
    }
  }

  get(jobId: string): CodingJob {
    const job = this.d.store.get(jobId);
    if (!job) throw new CodingJobNotFoundError(`coding job not found: ${jobId}`);
    return job;
  }
  list(workspacePath?: string): readonly CodingJob[] { return this.d.store.list(workspacePath); }

  async cancel(jobId: string): Promise<CodingJob> {
    let job = this.get(jobId);
    if (isCodingJobTerminal(job.state)) return job;
    if (job.state !== "cancelling") {
      job = transitionCodingJob(job, "cancelling", this.#now()); this.d.store.save(job);
    }
    const active = this.#active.get(jobId);
    if (active) await active.cancel("cancelled by user");
    return this.#terminal(jobId, false, "cancelled by user");
  }

  resume(jobId: string): CodingJob {
    const job = this.get(jobId);
    if (!job.checkpoint) throw new CodingJobResumeUnavailableError("coding job has no durable runner checkpoint");
    throw new CodingJobResumeUnavailableError("runner checkpoint resume is not implemented");
  }

  #terminal(jobId: string, ok: boolean, reason?: string, patch?: import("../domain/jeonju-course.js").JeonjuCoursePatch, releaseLease = true): CodingJob {
    const current = this.get(jobId);
    if (isCodingJobTerminal(current.state)) return current;
    let verification: { ok: boolean; summary: string } | undefined;
    if (ok && current.executionMode === "selected_workspace") {
      try {
        const applied = patch
          ? this.d.selectedWorkspace?.apply({ job: current, patch })
          : { ok: false, summary: "course proposal missing; no proposal was applied" };
        verification = applied?.ok
          ? this.d.selectedWorkspace?.verify({ job: current })
          : applied;
      } catch (error) {
        verification = {
          ok: false,
          summary: `selected workspace verification could not run: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const verified = verification?.ok ?? ok;
    // The selected-workspace guard remains authoritative, but do not erase the
    // bounded runner diagnostic that distinguishes a no-op from a CLI failure.
    const verificationSummary = verification && !verification.ok && reason
      ? `${verification.summary}; runner: ${reason}`
      : verification?.summary;
    const terminalReason = verification && !verification.ok ? verificationSummary : reason;
    const next = current.state === "cancelling"
      ? transitionCodingJob(current, "cancelled", this.#now(), reason)
      : { ...transitionCodingJob(current, verified ? "completed" : "failed", this.#now(), terminalReason), ...(verificationSummary ? { verificationSummary } : {}) };
    this.d.store.save(next);
    this.#reportCourseLifecycle(next);
    const active = this.#active.get(jobId);
    this.#active.delete(jobId);
    if (releaseLease) active?.allocation.release();
    return next;
  }

  #recoverInterruptedJobs(): void {
    for (const job of this.d.store.list()) {
      if (isCodingJobTerminal(job.state)) continue;
      const recoveredLease = job.executionMode !== "isolated_worktree" || this.d.worktrees.recover?.(job) === true;
      const failed = transitionCodingJob(
        job,
        "failed",
        this.#now(),
        recoveredLease
          ? "agent restarted before the coding job reached a terminal state"
          : "agent restarted before the coding job reached a terminal state; managed lease was retained for safety",
      );
      this.d.store.save(failed);
      this.#reportCourseLifecycle(failed);
    }
  }
  #reportCourseLifecycle(job: CodingJob): void {
    if (job.executionMode !== "selected_workspace" || !job.courseReply) return;
    const state = codingJobCourseLifecycleState(job.state);
    if (!state) return;
    try {
      this.d.courseLifecycle?.report({ jobId: job.jobId, state });
    } catch {
      // A chat status observer must not affect the durable job state.
    }
  }
}
