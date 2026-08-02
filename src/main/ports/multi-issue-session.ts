import type { IssueReport, IssueSnapshot, IssueStartRequest } from "../domain/issue-orchestration.js";
import type { ManagedIssueSession, MultiIssuePortfolio, MultiIssueSubmission, PendingSessionAnswer } from "../domain/multi-issue-session.js";

export interface SingleIssueExecutionPort {
  ensure(request: IssueStartRequest): IssueSnapshot | Promise<IssueSnapshot>;
  resume(issueId: string, signal?: AbortSignal): Promise<IssueReport>;
  answer(issueId: string, questionId: string, answer: string, signal?: AbortSignal): Promise<IssueReport>;
  cancel(issueId: string, signal?: AbortSignal): Promise<IssueReport>;
  snapshot(issueId: string): IssueSnapshot;
}

export interface MultiIssueSessionStore {
  createOrGet(input: {
    readonly submission: MultiIssueSubmission;
    readonly issue: IssueSnapshot;
    readonly sessionId: string;
    readonly now: string;
  }): { readonly snapshot: ManagedIssueSession; readonly created: boolean };
  get(sessionId: string): ManagedIssueSession | undefined;
  list(): readonly ManagedIssueSession[];
  requestCancellation(sessionId: string, now: string): ManagedIssueSession;
  queueAnswer(sessionId: string, answer: PendingSessionAnswer, now: string): ManagedIssueSession;
  tryAcquireScheduler(ownerId: string, nowMs: number, expiresAtMs: number): boolean;
  renewScheduler(ownerId: string, nowMs: number, expiresAtMs: number): boolean;
  releaseScheduler(ownerId: string): void;
  /** Atomically releases only when no ready work exists; false keeps ownership so the caller rechecks. */
  releaseSchedulerIfIdle(ownerId: string, nowMs: number, aggregateThresholdUsd?: number): boolean;
  recoverRunning(ownerId: string, nowMs: number, now: string): number;
  claimReady(input: {
    readonly ownerId: string;
    readonly nowMs: number;
    readonly now: string;
    readonly limit: number;
    readonly aggregateThresholdUsd?: number;
  }): readonly ManagedIssueSession[];
  /** Returns undefined when the caller lost the scheduler lease before the fenced write. */
  settle(sessionId: string, ownerId: string, nowMs: number, now: string, report: IssueReport): ManagedIssueSession | undefined;
  close(): void;
}

export interface MultiIssueSessionCommands {
  submit(input: MultiIssueSubmission): Promise<ManagedIssueSession>;
  answer(sessionId: string, questionId: string, answer: string): Promise<ManagedIssueSession>;
  cancel(sessionId: string): Promise<ManagedIssueSession>;
}

export interface MultiIssueSessionQueries {
  get(sessionId: string): ManagedIssueSession;
  list(): readonly ManagedIssueSession[];
  portfolio(): MultiIssuePortfolio;
}
