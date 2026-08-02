import { makeIssueTeamWorker, type IssueTeamWorkerOptions } from "../app/issue-team-worker.js";
import { isIssueTeamProfile, type WorkerProfile } from "../domain/issue-team.js";
import type { CodingJobWorktreePort } from "../ports/coding-job.js";
import type { IssueTeamStore } from "../ports/issue-team.js";
import type { IssueWorkerPort } from "../ports/issue-orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";
import {
  composeIssueTeamAgents, makeIssueTeamRoleExecutor, type IssueTeamAgentEnvironment,
} from "./issue-team-role-executor.js";

export function makeIssueWorkerRouter(input: { readonly legacy: IssueWorkerPort; readonly team: IssueWorkerPort }): IssueWorkerPort {
  const selected = (request: Parameters<IssueWorkerPort["execute"]>[0]) => request.profile && isIssueTeamProfile(request.profile) ? input.team : input.legacy;
  return {
    execute(request) { return selected(request).execute(request); },
    async recover(request) {
      const worker = selected(request);
      return worker.recover ? worker.recover(request) : worker.reconcile?.(request.dispatchId);
    },
    async reconcile(dispatchId) {
      const [team, legacy] = await Promise.all([input.team.reconcile?.(dispatchId), input.legacy.reconcile?.(dispatchId)]);
      if (team && legacy) throw new Error("worker dispatch identity collision");
      return team ?? legacy;
    },
  };
}

export function makeProfiledIssueWorker(options: {
  readonly legacy: IssueWorkerPort;
  readonly profiles: Readonly<Record<string, WorkerProfile>>;
  readonly store: IssueTeamStore;
  readonly worktrees: CodingJobWorktreePort;
  readonly diag: DiagnosticLog;
  readonly agentEnvironment?: IssueTeamAgentEnvironment;
  readonly nowMs?: () => number;
  readonly changedFiles?: IssueTeamWorkerOptions["changedFiles"];
}): IssueWorkerPort {
  const agents: Record<string, ReturnType<typeof composeIssueTeamAgents>[string]> = {};
  for (const profile of Object.values(options.profiles)) {
    if (!isIssueTeamProfile(profile)) continue;
    for (const [id, agent] of Object.entries(composeIssueTeamAgents(profile, options.agentEnvironment))) {
      if (agents[id]) throw new Error(`duplicate issue-team agent profile across catalog: ${id}`);
      agents[id] = agent;
    }
  }
  const roles = makeIssueTeamRoleExecutor({ agents, diag: options.diag, ...(options.nowMs ? { nowMs: options.nowMs } : {}) });
  const team = makeIssueTeamWorker({ store: options.store, worktrees: options.worktrees, roles,
    ...(options.diag ? { diag: options.diag } : {}), ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}) });
  return makeIssueWorkerRouter({ legacy: options.legacy, team });
}
