export const codingJobStates = [
  "queued", "running", "cancelling", "cancelled", "completed", "failed",
] as const;

export type CodingJobState = (typeof codingJobStates)[number];
export type CodingJobExecutionMode = "isolated_worktree" | "selected_workspace";

/**
 * The only lifecycle states a remote course channel may show.  It deliberately
 * excludes task text, paths, runner output, and verification diagnostics.
 */
export type CodingJobCourseLifecycleState = "received" | "running" | "completed" | "failed";

export function codingJobCourseLifecycleState(
  state: CodingJobState,
): CodingJobCourseLifecycleState | undefined {
  switch (state) {
    case "queued":
      return "received";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelling":
    case "cancelled":
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

export interface CodingJobCheckpoint {
  readonly runner: "codex";
  readonly threadId: string;
}

export interface CodingJob {
  readonly jobId: string;
  readonly workspacePath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leaseId: string;
  readonly task: string;
  // Optional only for durable records written before execution modes existed.
  // New jobs always persist this as `isolated_worktree` or `selected_workspace`.
  readonly executionMode?: CodingJobExecutionMode;
  readonly allowedFiles?: readonly string[];
  readonly verificationSummary?: string;
  readonly model?: string;
  readonly state: CodingJobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
  readonly checkpoint?: CodingJobCheckpoint;
}

export class CodingJobNotFoundError extends Error {}
export class CodingJobResumeUnavailableError extends Error {}

export class CodingJobTransitionError extends Error {
  constructor(readonly jobId: string, readonly from: CodingJobState, readonly to: CodingJobState) {
    super(`invalid coding job transition: ${from} -> ${to}`);
  }
}

const allowed: Readonly<Record<CodingJobState, readonly CodingJobState[]>> = {
  queued: ["running", "cancelling", "failed"],
  running: ["cancelling", "completed", "failed"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  completed: [],
  failed: [],
};

export function transitionCodingJob(
  job: CodingJob,
  to: CodingJobState,
  now: string,
  error?: string,
): CodingJob {
  if (!allowed[job.state].includes(to)) throw new CodingJobTransitionError(job.jobId, job.state, to);
  return { ...job, state: to, updatedAt: now, ...(error ? { error } : {}) };
}

export function isCodingJobTerminal(state: CodingJobState): boolean {
  return state === "cancelled" || state === "completed" || state === "failed";
}
