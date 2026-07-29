export const SUPERVISOR_REPORT_INTERVAL_MS = 10 * 60 * 1_000;

export type DurableRunState = "running" | "completed" | "failed";
export type DurableAttemptState = "queued" | "running" | "completed" | "timed_out";

export interface DurableRunRequest {
  readonly runId: string;
  readonly task: string;
}

export interface DurableDispatchCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly kind: "execute" | "progress_report";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DurableWorkerEvent {
  readonly runId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly leaseToken: string;
}

export interface DurableSupervisorSnapshot {
  readonly runState: DurableRunState;
  readonly nextReportAt: number | null;
  readonly attempts: ReadonlyArray<{
    readonly attemptId: string;
    readonly attemptNo: number;
    readonly executionId: string;
    readonly state: DurableAttemptState;
    readonly leaseToken: string | null;
    readonly leaseExpiresAt: number | null;
    readonly nextRetryAt: number | null;
  }>;
  readonly outbox: ReadonlyArray<{
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly kind: DurableDispatchCommand["kind"];
    readonly state: "pending" | "dispatching" | "acked";
    readonly availableAt: number;
  }>;
  readonly eventTypes: readonly string[];
}
