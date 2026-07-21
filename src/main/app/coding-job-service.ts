import { randomUUID } from "node:crypto";
import {
  CodingJobNotFoundError,
  CodingJobResumeUnavailableError,
  type CodingJob,
} from "../domain/coding-job.js";
import { isCodingJobTerminal, transitionCodingJob } from "../domain/coding-job.js";
import type { CodingJobAllocation, CodingJobControlPort, CodingJobRunnerPort, CodingJobStore, CodingJobWorktreePort } from "../ports/coding-job.js";
export { CodingJobNotFoundError, CodingJobResumeUnavailableError } from "../domain/coding-job.js";

export interface CodingJobServiceDeps {
  readonly store: CodingJobStore;
  readonly worktrees: CodingJobWorktreePort;
  readonly runner: CodingJobRunnerPort;
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
  }

  start(input: { workspacePath: string; task: string; model?: string }): CodingJob {
    if (!input.task.trim()) throw new Error("coding job task is required");
    const jobId = this.#ids();
    const allocation = this.d.worktrees.allocate({ jobId, workspacePath: input.workspacePath });
    const now = this.#now();
    let job: CodingJob = {
      jobId, workspacePath: allocation.workspacePath, worktreePath: allocation.worktreePath,
      branch: allocation.branch, leaseId: allocation.leaseId, task: input.task, ...(input.model ? { model: input.model } : {}),
      state: "queued", createdAt: now, updatedAt: now,
    };
    this.d.store.save(job);
    try {
      let cancel = async (_reason: string): Promise<void> => {};
      this.#active.set(jobId, { allocation, cancel: (reason) => cancel(reason) });
      const run = this.d.runner.start({ job, terminal: (result) => this.#terminal(jobId, result.ok, result.reason) });
      cancel = (reason) => run.cancel(reason);
      // A job is running only after the runner has successfully spawned.  A
      // spawn error leaves a durable failed record rather than a false running
      // status.
      job = transitionCodingJob(job, "running", this.#now());
      this.d.store.save(job);
      return job;
    } catch (error) {
      const current = this.d.store.get(jobId) ?? job;
      if (isCodingJobTerminal(current.state)) return current;
      const failed = transitionCodingJob(current, "failed", this.#now(), error instanceof Error ? error.message : String(error));
      this.d.store.save(failed); this.#active.delete(jobId); allocation.release();
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

  #terminal(jobId: string, ok: boolean, reason?: string): CodingJob {
    const current = this.get(jobId);
    if (isCodingJobTerminal(current.state)) return current;
    const next = current.state === "cancelling"
      ? transitionCodingJob(current, "cancelled", this.#now(), reason)
      : transitionCodingJob(current, ok ? "completed" : "failed", this.#now(), reason);
    this.d.store.save(next);
    const active = this.#active.get(jobId);
    this.#active.delete(jobId);
    active?.allocation.release();
    return next;
  }
}
