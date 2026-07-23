import type { CodingJob, CodingJobCourseLifecycleState, CodingJobCourseReply } from "../domain/coding-job.js";
import type { JeonjuCoursePatch } from "../domain/jeonju-course.js";

/**
 * Optional host-owned bridge for a course chat channel.  The service only
 * supplies a stable job id and a safe lifecycle state; the bridge must keep
 * the Discord binding/message association and delivery dedupe outside the
 * coding-job record.
 */
export interface CodingJobCourseLifecyclePort {
  report(input: {
    readonly jobId: string;
    readonly state: CodingJobCourseLifecycleState;
  }): void;
}

export interface CodingJobControlPort {
  start(input: { workspacePath: string; task: string; model?: string; executionMode?: "isolated_worktree" | "selected_workspace"; allowedFiles?: readonly string[]; courseReply?: CodingJobCourseReply }): CodingJob;
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
  /** Releases only the validated durable lease left by a prior Agent process. */
  recover?(input: Pick<CodingJob, "jobId" | "workspacePath" | "worktreePath" | "leaseId">): boolean;
}

/** Separate opt-in path for the workshop's direct student-repository mode. */
export interface SelectedWorkspaceCodingPort {
  prepare(input: { readonly jobId: string; readonly workspacePath: string; readonly allowedFiles: readonly string[] }): CodingJobAllocation;
  apply(input: { readonly job: CodingJob; readonly patch: JeonjuCoursePatch }): { readonly ok: boolean; readonly summary: string };
  verify(input: { readonly job: CodingJob }): { readonly ok: boolean; readonly summary: string };
}

export interface CodingJobRun {
  cancel(reason: string): Promise<void>;
}

export interface CodingJobRunnerPort {
  start(input: {
    readonly job: CodingJob;
    terminal(result: { ok: boolean; reason?: string; patch?: JeonjuCoursePatch }): void;
  }): CodingJobRun;
}
