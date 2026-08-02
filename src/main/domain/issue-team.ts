import type { ActorBinding, ActorReceipt, WorkerResult } from "./issue-orchestration.js";

export const ISSUE_TEAM_ROLES = ["explorer", "implementer", "tester", "reviewer"] as const;
export type IssueTeamRole = typeof ISSUE_TEAM_ROLES[number];
export type IssueTeamAgentKind = "codex" | "opencode" | "pi";
export type IssueTeamFilesystemAccess = "read_only" | "workspace_write";

export interface IssueTeamRoleProfile {
  readonly agentProfileId: string;
  readonly agentKind: IssueTeamAgentKind;
  readonly binding: ActorBinding;
  readonly filesystemAccess: IssueTeamFilesystemAccess;
}

export interface IssueTeamProfile {
  readonly kind: "team";
  readonly roles: Readonly<Record<IssueTeamRole, IssueTeamRoleProfile>>;
  readonly maxRepairCycles: number;
  readonly requiredCleanCycles: number;
}

export type WorkerProfile = ActorBinding | IssueTeamProfile;

export interface IssueTeamFinding { readonly code: string; readonly message: string }
export type IssueTeamDecision = "proceed" | "implemented" | "pass" | "fail" | "clean" | "changes_requested";
export interface IssueTeamRoleResult {
  readonly version: 1;
  readonly role: IssueTeamRole;
  readonly decision: IssueTeamDecision;
  readonly summary: string;
  readonly findings: readonly IssueTeamFinding[];
}

export interface IssueTeamProjection {
  readonly profileId: string;
  readonly profileDigest: string;
  readonly cleanCycles: number;
  readonly repairCycles: number;
  readonly outcomes: readonly IssueTeamRoleResult[];
}

export type IssueTeamRunState = "ready" | "running" | "completed" | "failed";
export interface IssueTeamAllocationEvidence {
  readonly workspacePath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leaseId: string;
}
export interface IssueTeamRunSnapshot {
  readonly version: number;
  readonly dispatchId: string;
  readonly fingerprint: string;
  readonly issueId: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly state: IssueTeamRunState;
  readonly nextRole: IssueTeamRole;
  readonly attemptNo: number;
  readonly activeStepId?: string;
  readonly allocation: IssueTeamAllocationEvidence;
  readonly cleanCycles: number;
  readonly repairCycles: number;
  readonly outcomes: readonly IssueTeamRoleResult[];
  readonly receipts: readonly ActorReceipt[];
  readonly result?: WorkerResult;
}

export function isIssueTeamProfile(value: WorkerProfile): value is IssueTeamProfile {
  return "kind" in value && value.kind === "team";
}

export function assertIssueTeamProfile(profile: IssueTeamProfile): void {
  if (profile.kind !== "team" || !Number.isSafeInteger(profile.maxRepairCycles) || profile.maxRepairCycles < 1 || profile.maxRepairCycles > 32
    || !Number.isSafeInteger(profile.requiredCleanCycles) || profile.requiredCleanCycles < 1 || profile.requiredCleanCycles > 8) {
    throw new Error("invalid issue-team loop bounds");
  }
  const ids = new Set<string>();
  const concrete = (value: string) => value.length > 0 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  for (const role of ISSUE_TEAM_ROLES) {
    const declared = profile.roles[role];
    if (!declared || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(declared.agentProfileId)
      || !(["codex", "opencode", "pi"] as const).includes(declared.agentKind)
      || !concrete(declared.binding.provider) || !concrete(declared.binding.model)
      || (declared.binding.reasoningEffort !== undefined && !["low", "medium", "high", "xhigh"].includes(declared.binding.reasoningEffort))) {
      throw new Error(`invalid issue-team ${role} profile`);
    }
    if (ids.has(declared.agentProfileId)) throw new Error("duplicate issue-team agent profile id");
    ids.add(declared.agentProfileId);
    const expected = role === "implementer" ? "workspace_write" : "read_only";
    if (declared.filesystemAccess !== expected) throw new Error(`invalid issue-team ${role} filesystem access`);
  }
  if (Object.keys(profile.roles).length !== ISSUE_TEAM_ROLES.length) throw new Error("issue-team profile must contain exactly four roles");
}

export function isActorBinding(profile: WorkerProfile): profile is ActorBinding { return !isIssueTeamProfile(profile); }

/** Stable provider-neutral bytes used by app-layer SHA-256 profile binding. */
export function canonicalIssueTeamProfile(profile: IssueTeamProfile): string {
  return stableJson(profile);
}

/** Stable bytes for binding every worker request to its predeclared catalog entry. */
export function canonicalWorkerProfile(profile: WorkerProfile): string {
  return stableJson(profile);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
