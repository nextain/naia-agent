import { makeCodexSubAgent, type SubAgentCodexOptions } from "../adapters/subagent-codex.js";
import { makeClaudeCodeSubAgent, type SubAgentClaudeCodeOptions } from "../adapters/subagent-claude-code.js";
import { makeOpencodeSubAgent, type SubAgentOpencodeOptions } from "../adapters/subagent-opencode-cli.js";
import { makePiSubAgent, type SubAgentPiOptions } from "../adapters/subagent-pi.js";
import { assertIssueTeamProfile, type IssueTeamProfile } from "../domain/issue-team.js";
import type { SubAgentPort } from "../ports/orchestration.js";

export interface IssueTeamAgentEnvironment {
  readonly codex?: Omit<SubAgentCodexOptions, "model" | "reasoningEffort">;
  readonly claudeCode?: Omit<SubAgentClaudeCodeOptions, "model">;
  readonly opencode?: Omit<SubAgentOpencodeOptions, "model" | "provider">;
  readonly pi?: Omit<SubAgentPiOptions, "model" | "provider">;
}

export function composeIssueTeamAgents(profile: IssueTeamProfile, environment: IssueTeamAgentEnvironment = {}):
Readonly<Record<string, { readonly agentKind: import("../domain/issue-team.js").IssueTeamAgentKind; readonly adapter: SubAgentPort }>> {
  assertIssueTeamProfile(profile);
  return Object.fromEntries(Object.values(profile.roles).map((declared) => {
    const agent = declared.agentKind === "codex"
      ? makeCodexSubAgent({ ...environment.codex, model: declared.binding.model,
        ...(declared.binding.reasoningEffort ? { reasoningEffort: declared.binding.reasoningEffort as SubAgentCodexOptions["reasoningEffort"] } : {}) })
      : declared.agentKind === "claude-code"
        ? makeClaudeCodeSubAgent({ ...environment.claudeCode, model: declared.binding.model })
      : declared.agentKind === "opencode"
        ? makeOpencodeSubAgent({ ...environment.opencode, model: declared.binding.model, provider: declared.binding.provider })
        : makePiSubAgent({ ...environment.pi, model: declared.binding.model, provider: declared.binding.provider });
    return [declared.agentProfileId, { agentKind: declared.agentKind, adapter: agent }];
  }));
}
