export type IssueState =
  | "accepted"
  | "classifying"
  | "classified"
  | "planning"
  | "moderator_running"
  | "awaiting_user"
  | "dispatch_ready"
  | "worker_running"
  | "verifying"
  | "reporting"
  | "reporter_running"
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
  readonly reasoningEffort?: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly tokenCountsAvailable: boolean;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly modelEvidenceSource?: "provider_reported" | "adapter_requested";
  readonly cost: CostEvidence;
  /** Pi-local priced-usage estimate; operational budgeting only, never a provider invoice claim. */
  readonly estimatedCostUsd?: number;
  readonly estimatedCostSource?: "pi_catalog";
  /** Exact request-level gateway settlement evidence retained for audit/benchmark extraction. */
  readonly gatewayBillingReceipts?: readonly import("./orchestration.js").GatewayBillingReceipt[];
  readonly workerRole?: import("./issue-team.js").IssueTeamRole;
  readonly agentProfileId?: string;
  readonly agentKind?: import("./issue-team.js").IssueTeamAgentKind;
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
  readonly receipts?: readonly ActorReceipt[];
  readonly team?: import("./issue-team.js").IssueTeamProjection;
}

export interface IssueVerification {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly pass: boolean; readonly details?: string }[];
  readonly receipt: ActorReceipt;
}

export interface IssueReport {
  readonly state: IssueTerminalState | "awaiting_user" | "chat";
  readonly summary: string;
  /** Naia-authored narrative from durable evidence; never authoritative for state or verification. */
  readonly naiaCommentary?: string;
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
  readonly requiredObligations: readonly string[];
  readonly workspacePath: string;
  readonly state: IssueState;
  readonly cancellationRequestedAt?: string;
  readonly naiaBinding: ActorBinding;
  readonly moderatorBinding: ActorBinding;
  readonly workerProfiles: Readonly<Record<string, import("./issue-team.js").WorkerProfile>>;
  readonly workerProfile?: import("./issue-team.js").WorkerProfile;
  readonly workerBinding?: ActorBinding;
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
  /** Intake-authoritative ordered obligations. Chat uses an empty array; work must be non-empty. */
  readonly requiredObligations: readonly string[];
  readonly workspacePath: string;
  readonly naiaBinding: ActorBinding;
  readonly moderatorBinding: ActorBinding;
  readonly workerProfiles: Readonly<Record<string, import("./issue-team.js").WorkerProfile>>;
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

export function groundedIssueSummary(issue: IssueSnapshot, terminal: "completed" | "failed"): string {
  const files = issue.worker?.changedFiles.length ?? 0;
  const verification = issue.verification?.ok === true ? "passed" : issue.verification?.ok === false ? "failed" : "not-run";
  return `state=${terminal}; changedFiles=${files}; verification=${verification}`;
}

export function groundedIssueCommentary(issue: IssueSnapshot, terminal: "completed" | "failed"): string {
  const changedFiles = issue.worker?.changedFiles ?? [];
  const files = changedFiles.length > 0 ? changedFiles.join(", ") : "none";
  const verification = issue.verification?.ok === true ? "passed" : issue.verification?.ok === false ? "failed" : "not run";
  return `${terminal === "completed" ? "Completed" : "Failed"}. Changed files: ${files}. Verification: ${verification}.`;
}
