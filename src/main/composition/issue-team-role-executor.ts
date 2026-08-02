import { Supervisor } from "../app/supervisor.js";
import type { ActorReceipt } from "../domain/issue-orchestration.js";
import type { IssueTeamRoleResult } from "../domain/issue-team.js";
import type { IssueTeamRoleExecutorPort } from "../ports/issue-team.js";
import { IssueActorResultError } from "../ports/issue-orchestration.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";
import { makeCodexSubAgent, type SubAgentCodexOptions } from "../adapters/subagent-codex.js";
import { makeOpencodeSubAgent, type SubAgentOpencodeOptions } from "../adapters/subagent-opencode-cli.js";
import { makePiSubAgent, type SubAgentPiOptions } from "../adapters/subagent-pi.js";
import { assertIssueTeamProfile, type IssueTeamProfile } from "../domain/issue-team.js";

export interface IssueTeamRoleExecutorOptions {
  readonly agents: Readonly<Record<string, SubAgentPort>>;
  readonly diag: DiagnosticLog;
  readonly nowMs?: () => number;
}

export function makeIssueTeamRoleExecutor(options: IssueTeamRoleExecutorOptions): IssueTeamRoleExecutorPort {
  return {
    async execute(input) {
      const subAgent = options.agents[input.roleProfile.agentProfileId];
      if (!subAgent) throw new Error(`undeclared issue-team agent profile: ${input.roleProfile.agentProfileId}`);
      const startedAt = (options.nowMs ?? Date.now)();
      let text = ""; let overflow = false; let report: import("../domain/orchestration.js").SupervisorReport | undefined;
      const supervisor = new Supervisor({
        subAgent, diag: options.diag,
        egress: {
          event(event) {
            if (event.kind !== "text_delta" || overflow) return;
            if (Buffer.byteLength(text, "utf8") + Buffer.byteLength(event.text, "utf8") > 64 * 1024) { overflow = true; return; }
            text += event.text;
          },
          report(value) { report = value; },
        },
      });
      await supervisor.run({ prompt: rolePrompt(input), workdir: input.worktreePath,
        model: input.roleProfile.binding.model, filesystemAccess: input.roleProfile.filesystemAccess }, input.signal);
      const evidence = report?.modelEvidence;
      if (!evidence?.provider || !evidence.selectedModel || !evidence.sessionId || !evidence.executionId) throw new Error("role receipt evidence unavailable");
      const receipt: ActorReceipt = {
        role: "worker", workerRole: roleFromStep(input.stepId),
        agentProfileId: input.roleProfile.agentProfileId, agentKind: input.roleProfile.agentKind,
        provider: evidence.provider, model: evidence.selectedModel,
        ...(evidence.reasoningEffort ? { reasoningEffort: evidence.reasoningEffort } : {}),
        sessionId: evidence.sessionId, executionId: evidence.executionId, idempotencyKey: input.stepId,
        tokenCountsAvailable: evidence.usageAvailable === true,
        inputTokens: evidence.usageAvailable === true ? evidence.inputTokens : 0,
        cachedInputTokens: evidence.usageAvailable === true ? evidence.cachedInputTokens ?? 0 : 0,
        outputTokens: evidence.usageAvailable === true ? evidence.outputTokens : 0,
        latencyMs: Math.max(0, (options.nowMs ?? Date.now)() - startedAt),
        ...(evidence.modelEvidenceSource ? { modelEvidenceSource: evidence.modelEvidenceSource } : {}),
        cost: evidence.usageAvailable === true && evidence.measuredCostUsd !== undefined
          ? { state: "measured", usd: evidence.measuredCostUsd, source: "role_adapter_priced_usage" }
          : { state: "unavailable", reason: "role adapter did not receive priced usage" },
      };
      if (evidence.provider !== input.roleProfile.binding.provider || evidence.selectedModel !== input.roleProfile.binding.model
        || (input.roleProfile.binding.reasoningEffort !== undefined && evidence.reasoningEffort !== input.roleProfile.binding.reasoningEffort)) {
        throw new IssueActorResultError("role model binding mismatch", receipt);
      }
      if (!report?.sessionOk || overflow) throw new IssueActorResultError(overflow ? "role output exceeded 64 KiB" : "role session failed", receipt);
      let result: IssueTeamRoleResult;
      try { result = JSON.parse(text) as IssueTeamRoleResult; }
      catch { throw new IssueActorResultError("role output was not one JSON object", receipt); }
      return { result, receipt: { ...receipt, workerRole: result.role } };
    },
  };
}

export function composeIssueTeamAgents(profile: IssueTeamProfile, environment: {
  readonly codex?: Omit<SubAgentCodexOptions, "model" | "reasoningEffort">;
  readonly opencode?: Omit<SubAgentOpencodeOptions, "model" | "provider">;
  readonly pi?: Omit<SubAgentPiOptions, "model" | "provider">;
} = {}): Readonly<Record<string, SubAgentPort>> {
  assertIssueTeamProfile(profile);
  return Object.fromEntries(Object.values(profile.roles).map((declared) => {
    const agent = declared.agentKind === "codex"
      ? makeCodexSubAgent({ ...environment.codex, model: declared.binding.model, ...(declared.binding.reasoningEffort ? { reasoningEffort: declared.binding.reasoningEffort as SubAgentCodexOptions["reasoningEffort"] } : {}) })
      : declared.agentKind === "opencode"
        ? makeOpencodeSubAgent({ ...environment.opencode, model: declared.binding.model, provider: declared.binding.provider })
        : makePiSubAgent({ ...environment.pi, model: declared.binding.model, provider: declared.binding.provider });
    return [declared.agentProfileId, agent];
  }));
}

function rolePrompt(input: Parameters<IssueTeamRoleExecutorPort["execute"]>[0]): string {
  return `You are the ${input.roleProfile.filesystemAccess === "workspace_write" ? "implementation" : "read-only"} role for one coding issue.\n`
    + `Task: ${input.task}\nContext JSON: ${input.context}\n`
    + "Return exactly one JSON object: {\"version\":1,\"role\":\"explorer|implementer|tester|reviewer\",\"decision\":\"role-valid decision\",\"summary\":\"...\",\"findings\":[{\"code\":\"...\",\"message\":\"...\"}]}";
}
function roleFromStep(stepId: string): import("../domain/issue-team.js").IssueTeamRole {
  for (const role of ["explorer", "implementer", "tester", "reviewer"] as const) if (stepId.includes(`:${role}:`)) return role;
  throw new Error("invalid role step id");
}
