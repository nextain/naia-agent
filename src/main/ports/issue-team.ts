import type { ActorReceipt } from "../domain/issue-orchestration.js";
import type { IssueTeamRoleProfile, IssueTeamRoleResult, IssueTeamRunSnapshot } from "../domain/issue-team.js";

export interface IssueTeamRoleExecutorPort {
  execute(input: {
    readonly issueId: string;
    readonly dispatchId: string;
    readonly stepId: string;
    readonly worktreePath: string;
    readonly task: string;
    readonly context: string;
    readonly roleProfile: IssueTeamRoleProfile;
    readonly signal: AbortSignal;
  }): Promise<{ readonly result: IssueTeamRoleResult; readonly receipt: ActorReceipt }>;
}

export interface IssueTeamStore {
  createOrGet(snapshot: IssueTeamRunSnapshot): { readonly snapshot: IssueTeamRunSnapshot; readonly created: boolean };
  get(dispatchId: string): IssueTeamRunSnapshot | undefined;
  save(input: { readonly expectedVersion: number; readonly snapshot: IssueTeamRunSnapshot; readonly eventType: string }): IssueTeamRunSnapshot;
  close(): void;
}
