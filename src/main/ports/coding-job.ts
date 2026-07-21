import type { CodingJob } from "../domain/coding-job.js";

export interface CodingJobControlPort {
  start(input: { workspacePath: string; task: string; model?: string }): CodingJob;
  get(jobId: string): CodingJob;
  list(workspacePath?: string): readonly CodingJob[];
  cancel(jobId: string): Promise<CodingJob>;
  resume(jobId: string): CodingJob;
}

export interface CodingJobStore {
  get(jobId: string): CodingJob | undefined;
  list(workspacePath?: string): readonly CodingJob[];
  save(job: CodingJob): void;
}

export interface CodingJobAllocation {
  readonly workspacePath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leaseId: string;
  release(): void;
}

export interface CodingJobWorktreePort {
  allocate(input: { jobId: string; workspacePath: string }): CodingJobAllocation;
}

export interface CodingJobRun {
  cancel(reason: string): Promise<void>;
}

export interface CodingJobRunnerPort {
  start(input: {
    readonly job: CodingJob;
    terminal(result: { ok: boolean; reason?: string }): void;
  }): CodingJobRun;
}
