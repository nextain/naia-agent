export type IssueState =
  | "accepted"
  | "classified"
  | "planning"
  | "awaiting_user"
  | "dispatch_ready"
  | "worker_running"
  | "verifying"
  | "reporting"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export type IssueTerminalState = "completed" | "failed" | "cancelled" | "outcome_unknown";

export interface ActorBinding {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export type CostEvidence =
  | { readonly state: "measured"; readonly usd: number; readonly source: string }
  | { readonly state: "unavailable"; readonly reason: string };

export interface ActorReceipt {
  readonly role: "naia" | "moderator" | "worker" | "verifier" | "reporter";
  readonly provider: string;
  readonly model: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly cost: CostEvidence;
}

export interface IssueClassification {
  readonly kind: "chat" | "work";
  readonly obligations: readonly string[];
  readonly chatReply?: string;
}

export interface ModeratorQuestion {
  readonly questionId: string;
  readonly text: string;
}

export interface ModeratorPlan {
  readonly workerTask: string;
  readonly workerProfile: string;
  readonly acceptanceChecks: readonly string[];
  readonly questions: readonly ModeratorQuestion[];
}

export interface WorkerResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly worktreePath: string;
  readonly changedFiles: readonly string[];
  readonly receipt: ActorReceipt;
}

export interface IssueVerification {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly pass: boolean; readonly details?: string }[];
  readonly receipt: ActorReceipt;
}

export interface IssueReport {
  readonly state: IssueTerminalState | "awaiting_user" | "chat";
  readonly summary: string;
  readonly issueId?: string;
  readonly question?: ModeratorQuestion;
  readonly changedFiles: readonly string[];
  readonly verificationPassed: boolean | null;
  readonly totalCost: CostEvidence;
}

export interface IssueAnswer {
  readonly questionId: string;
  readonly text: string;
}

export interface IssueSnapshot {
  readonly version: number;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly issueId: string;
  readonly originalText: string;
  readonly workspacePath: string;
  readonly state: IssueState;
  readonly naiaBinding: ActorBinding;
  readonly moderatorBinding: ActorBinding;
  readonly classification?: IssueClassification;
  readonly plan?: ModeratorPlan;
  readonly answers: readonly IssueAnswer[];
  readonly dispatchId?: string;
  readonly worker?: WorkerResult;
  readonly verification?: IssueVerification;
  readonly report?: IssueReport;
  readonly receipts: readonly ActorReceipt[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueEvent {
  readonly sequence: number;
  readonly issueId: string;
  readonly type: string;
  readonly state: IssueState;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface IssueStartRequest {
  readonly requestId: string;
  readonly text: string;
  readonly workspacePath: string;
  readonly naiaBinding: ActorBinding;
  readonly moderatorBinding: ActorBinding;
}

export function isIssueTerminal(state: IssueState): state is IssueTerminalState {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "outcome_unknown";
}

export function totalIssueCost(receipts: readonly ActorReceipt[]): CostEvidence {
  const unavailable = receipts.find((receipt) => receipt.cost.state === "unavailable");
  if (unavailable?.cost.state === "unavailable") {
    return { state: "unavailable", reason: `incomplete ${unavailable.role} cost: ${unavailable.cost.reason}` };
  }
  const usd = receipts.reduce((sum, receipt) => sum + (receipt.cost.state === "measured" ? receipt.cost.usd : 0), 0);
  return { state: "measured", usd, source: "sum_of_persisted_actor_receipts" };
}
