import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeGitCodingJobWorktrees } from "../adapters/coding-job-worktree.js";
import { makeStderrDiagnostic } from "../adapters/diagnostic.js";
import { makePiSubAgent, type SubAgentPiOptions } from "../adapters/subagent-pi.js";
import {
  makeIssueVerifierAdapter, makeSubAgentDevelopmentModerator, makeSubAgentNaiaFacing,
  makeSubAgentNaiaReporter,
} from "../adapters/subagent-issue-actors.js";
import { SqliteIssueOrchestrationStore } from "../adapters/sqlite-issue-orchestration-store.js";
import { SqliteIssueTeamStore } from "../adapters/sqlite-issue-team-store.js";
import { SqliteMultiIssueSessionStore } from "../adapters/sqlite-multi-issue-session-store.js";
import { SqlitePaidCallBudget } from "../adapters/sqlite-paid-call-budget.js";
import { initializeGatewayRequestBudget } from "../adapters/naia-pi-versioned-billing.js";
import { isNaiaPiAnalysisOnlyModel, isNaiaPiModel, NAIA_PI_PROVIDER } from "../adapters/naia-pi-provider.js";
import { isUserOwnedPiBinding } from "../adapters/user-owned-pi-provider.js";
import { makeCommandVerifier, type CommandCheck } from "../adapters/verifier-commands.js";
import { makeIssueTeamWorker } from "../app/issue-team-worker.js";
import { MultiIssueSessionManager } from "../app/multi-issue-session-manager.js";
import { SingleIssueOrchestrator } from "../app/single-issue-orchestrator.js";
import type { ActorBinding } from "../domain/issue-orchestration.js";
import { assertIssueTeamProfile, type IssueTeamProfile, type IssueTeamRole } from "../domain/issue-team.js";
import type { PaidCallAllowance, PaidCallBudgetPolicy } from "../ports/paid-call-budget.js";
import type { DiagnosticLog } from "../ports/uc1.js";
import type { CodingJobWorktreePort } from "../ports/coding-job.js";
import type { IssueVerifierPort } from "../ports/issue-orchestration.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import { makeIssueTeamRoleExecutor } from "./issue-team-role-executor.js";
import { gitChangedFiles } from "./supervised-issue-worker.js";

export interface PiContinuousLoopConfig {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly worktreeRoot: string;
  readonly facing: ActorBinding;
  readonly moderator: ActorBinding;
  readonly reporter: ActorBinding;
  readonly roles: Readonly<Record<IssueTeamRole, ActorBinding>>;
  readonly profileId: string;
  readonly maxRepairCycles: number;
  readonly requiredCleanCycles: number;
  readonly acceptanceChecks: readonly CommandCheck[];
  readonly concurrency: number;
  readonly budget: PaidCallBudgetPolicy;
  readonly callAllowance: PaidCallAllowance;
  readonly pi?: Omit<SubAgentPiOptions, "provider" | "model" | "noTools">;
  readonly diag?: DiagnosticLog;
}

export interface PiContinuousLoopRuntimeOverrides {
  readonly makeSubAgent?: (binding: ActorBinding, write: boolean) => SubAgentPort;
  readonly worktrees?: CodingJobWorktreePort;
  readonly verifier?: IssueVerifierPort;
  readonly changedFiles?: (worktreePath: string) => readonly string[];
  readonly issueIds?: () => string;
  readonly issueOwnerIds?: () => string;
  readonly sessionIds?: () => string;
  readonly sessionOwnerIds?: () => string;
  readonly now?: () => string;
  readonly clockMs?: () => number;
}

export function makePiOnlyTeamProfile(config: Pick<PiContinuousLoopConfig,
  "roles" | "maxRepairCycles" | "requiredCleanCycles">): IssueTeamProfile {
  if (isNaiaPiAnalysisOnlyModel(config.roles.implementer.model)) {
    throw new Error(`analysis-only ${config.roles.implementer.model} cannot be the writing implementer`);
  }
  const role = (name: IssueTeamRole) => ({ agentProfileId: `pi-${name}`, agentKind: "pi" as const,
    binding: config.roles[name], filesystemAccess: name === "implementer" ? "workspace_write" as const : "read_only" as const });
  const profile: IssueTeamProfile = { kind: "team", roles: { explorer: role("explorer"),
    implementer: role("implementer"), tester: role("tester"), reviewer: role("reviewer") },
    maxRepairCycles: config.maxRepairCycles, requiredCleanCycles: config.requiredCleanCycles };
  assertIssueTeamProfile(profile);
  return profile;
}

export function makePiContinuousLoop(config: PiContinuousLoopConfig, runtime: PiContinuousLoopRuntimeOverrides = {}) {
  validateConfig(config);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(config.stateDir);
  const diag = config.diag ?? makeStderrDiagnostic();
  const opened: Array<{ close(): void }> = [];
  try {
    const budget = new SqlitePaidCallBudget(join(stateDir, "paid-calls.db"), config.budget); opened.push(budget);
    const issueStore = new SqliteIssueOrchestrationStore(join(stateDir, "issues.db")); opened.push(issueStore);
    const teamStore = new SqliteIssueTeamStore(join(stateDir, "teams.db")); opened.push(teamStore);
    const sessionStore = new SqliteMultiIssueSessionStore(join(stateDir, "sessions.db")); opened.push(sessionStore);
    const gatewayBudget = config.pi?.gatewayBudget ?? { path: join(stateDir, "gateway-requests.db"),
      policy: { maxGatewayCalls: config.budget.maxPaidCalls, maxUsd: config.budget.maxUsd,
        maxInputTokens: config.budget.maxInputTokens, maxOutputTokens: config.budget.maxOutputTokens,
        requestAllowance: config.callAllowance } };
    initializeGatewayRequestBudget(gatewayBudget.path, gatewayBudget.policy);
    const profile = makePiOnlyTeamProfile(config);
    const pi = (binding: ActorBinding, write = false) => runtime.makeSubAgent?.(binding, write) ?? makePiSubAgent({ ...config.pi,
      provider: binding.provider, model: binding.model,
      maxOutputTokens: config.callAllowance.reservedOutputTokens,
      gatewayBudget,
      ...(isNaiaPiAnalysisOnlyModel(binding.model) && !write ? { noTools: true } : {}) });
    const actor = (binding: ActorBinding) => ({ subAgent: pi(binding), binding,
      workdir: realpathSync(config.workspaceRoot), diag, budget, callAllowance: config.callAllowance });
    const agents = Object.fromEntries((Object.keys(profile.roles) as IssueTeamRole[]).map((name) => {
      const declared = profile.roles[name];
      return [declared.agentProfileId, { agentKind: "pi" as const,
        adapter: pi(declared.binding, name === "implementer") }];
    }));
    const roles = makeIssueTeamRoleExecutor({ agents, diag, budget, callAllowance: config.callAllowance });
    const worker = makeIssueTeamWorker({ store: teamStore,
      worktrees: runtime.worktrees ?? makeGitCodingJobWorktrees({ allowedWorkspaceRoot: config.workspaceRoot,
        worktreeRoot: resolve(config.worktreeRoot) }), roles, changedFiles: runtime.changedFiles ?? gitChangedFiles });
    const verifier = runtime.verifier ?? makeIssueVerifierAdapter(makeCommandVerifier({ checks: config.acceptanceChecks }));
    const issues = new SingleIssueOrchestrator({ store: issueStore,
      facing: makeSubAgentNaiaFacing(actor(config.facing)),
      moderator: makeSubAgentDevelopmentModerator({ ...actor(config.moderator),
        allowedWorkerProfiles: [config.profileId], allowedAcceptanceChecks: config.acceptanceChecks.map((check) => check.name) }),
      worker, verifier, reporter: makeSubAgentNaiaReporter(actor(config.reporter)), diag,
      ...(runtime.issueIds ? { ids: runtime.issueIds } : {}),
      ...(runtime.issueOwnerIds ? { ownerIds: runtime.issueOwnerIds } : {}),
      ...(runtime.now ? { now: runtime.now } : {}), ...(runtime.clockMs ? { clockMs: runtime.clockMs } : {}) });
    const sessions = new MultiIssueSessionManager({ store: sessionStore, issues,
      concurrency: config.concurrency, autoPump: false, diag,
      ...(runtime.sessionIds ? { ids: runtime.sessionIds } : {}),
      ...(runtime.sessionOwnerIds ? { ownerIds: runtime.sessionOwnerIds } : {}),
      ...(runtime.now ? { now: runtime.now } : {}), ...(runtime.clockMs ? { clockMs: runtime.clockMs } : {}) });
    return { sessions, issues, profile, budget, close() {
      sessionStore.close(); teamStore.close(); issueStore.close(); budget.close();
    } };
  } catch (error) {
    for (const resource of opened.reverse()) { try { resource.close(); } catch { /* preserve the construction error */ } }
    throw error;
  }
}

function validateConfig(config: PiContinuousLoopConfig): void {
  const bindings = [config.facing, config.moderator, config.reporter, ...Object.values(config.roles)];
  if (bindings.some((binding) => !((binding.provider === NAIA_PI_PROVIDER && isNaiaPiModel(binding.model))
    || isUserOwnedPiBinding(config.pi?.userOwnedProvider, binding)))) {
    throw new Error("Pi continuous-loop bindings must use an active Naia or declared user-owned Pi catalog model");
  }
  if (bindings.some((binding) => binding.reasoningEffort !== undefined)) {
    throw new Error("Pi continuous-loop bindings do not support reasoningEffort");
  }
  if (!Number.isSafeInteger(config.concurrency) || config.concurrency <= 0) throw new Error("concurrency must be a positive integer");
}
