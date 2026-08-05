import type { CostEvidence, IssueReport, IssueStartRequest } from "./issue-orchestration.js";

export type SessionSourceKind = "local" | "discord" | "shell" | "other";
export type ManagedSessionState = "queued" | "running" | "awaiting_user" | "chat"
  | "completed" | "failed" | "cancelled" | "outcome_unknown";

export interface SessionSource {
  readonly kind: SessionSourceKind;
  readonly sourceId: string;
  readonly actorId: string;
}

export interface MultiIssueSubmission {
  readonly request: IssueStartRequest;
  readonly source: SessionSource;
  readonly reservationUsd?: number;
}

export interface PendingSessionAnswer {
  readonly questionId: string;
  readonly text: string;
}

export interface ManagedIssueSession {
  readonly version: number;
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly issueId: string;
  readonly workspacePath: string;
  readonly source: SessionSource;
  readonly state: ManagedSessionState;
  readonly readyPriority: "recovery" | "normal";
  readonly readySequence: number;
  readonly runOwnerId?: string;
  readonly cancellationRequested: boolean;
  readonly pendingAnswer?: PendingSessionAnswer;
  readonly reservationUsd?: number;
  readonly report?: IssueReport;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MultiIssuePortfolio {
  readonly sessions: readonly ManagedIssueSession[];
  readonly counts: Readonly<Record<ManagedSessionState, number>>;
  readonly totalCost: CostEvidence;
  readonly activeReservationsUsd: number;
  readonly budgetBlocked: boolean;
}

export function isManagedSessionTerminal(state: ManagedSessionState): boolean {
  return ["chat", "completed", "failed", "cancelled", "outcome_unknown"].includes(state);
}

export function emptySessionCounts(): Record<ManagedSessionState, number> {
  return {
    queued: 0, running: 0, awaiting_user: 0, chat: 0,
    completed: 0, failed: 0, cancelled: 0, outcome_unknown: 0,
  };
}
