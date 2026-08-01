import type {
  ActorBinding,
  ActorReceipt,
  IssueAnswer,
  IssueClassification,
  IssueEvent,
  IssueReport,
  IssueSnapshot,
  IssueStartRequest,
  IssueVerification,
  ModeratorPlan,
  WorkerResult,
} from "../domain/issue-orchestration.js";

/** A paid actor completed and produced a trustworthy receipt, but its semantic result was rejected. */
export class IssueActorResultError extends Error {
  constructor(message: string, readonly receipt: ActorReceipt) { super(message); this.name = "IssueActorResultError"; }
}

export interface NaiaFacingPort {
  classify(input: {
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly text: string;
    readonly requiredObligations: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly classification: IssueClassification; readonly receipt: ActorReceipt }>;
}

export interface DevelopmentModeratorPort {
  plan(input: {
    readonly issueId: string;
    readonly idempotencyKey: string;
    readonly originalText: string;
    readonly obligations: readonly string[];
    readonly answers: readonly IssueAnswer[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly plan: ModeratorPlan; readonly receipt: ActorReceipt }>;
}

export interface IssueWorkerPort {
  /** The adapter must reconcile or deduplicate repeated calls with the same dispatchId. */
  execute(input: {
    readonly issueId: string;
    readonly dispatchId: string;
    readonly workspacePath: string;
    readonly task: string;
    readonly profileId: string;
    readonly binding: ActorBinding;
    readonly acceptanceChecks: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<WorkerResult>;
  /** Returns an exact persisted result for a prior dispatch, or undefined when its outcome cannot be proven. */
  reconcile?(dispatchId: string): Promise<WorkerResult | undefined>;
}

export interface IssueVerifierPort {
  verify(input: {
    readonly issueId: string;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
    readonly worktreePath: string;
    readonly acceptanceChecks: readonly string[];
  }): Promise<IssueVerification>;
}

export interface NaiaIssueReporterPort {
  report(input: {
    readonly issue: IssueSnapshot & { readonly state: "completed" | "failed" };
    readonly events: readonly IssueEvent[];
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly report: Omit<IssueReport, "totalCost">; readonly receipt: ActorReceipt }>;
}

export interface IssueOrchestrationStore {
  create(request: IssueStartRequest, input: { readonly issueId: string; readonly requestDigest: string; readonly now: string }): IssueSnapshot;
  createOrGet(request: IssueStartRequest, input: { readonly issueId: string; readonly requestDigest: string; readonly now: string }): {
    readonly snapshot: IssueSnapshot;
    readonly created: boolean;
  };
  get(issueId: string): IssueSnapshot | undefined;
  getByRequestId(requestId: string): IssueSnapshot | undefined;
  /** Atomically acquires an expiring cross-process execution claim for one issue. */
  tryAcquireExecution(issueId: string, ownerId: string, nowMs: number, expiresAtMs: number): boolean;
  renewExecution(issueId: string, ownerId: string, nowMs: number, expiresAtMs: number): boolean;
  releaseExecution(issueId: string, ownerId: string): void;
  requestCancellation(issueId: string, now: string): IssueSnapshot;
  save(input: {
    readonly expectedVersion: number;
    readonly snapshot: IssueSnapshot;
    readonly eventType: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly executionOwnerId?: string;
    readonly executionNowMs?: number;
  }): IssueSnapshot;
  events(issueId: string): readonly IssueEvent[];
  close(): void;
}
