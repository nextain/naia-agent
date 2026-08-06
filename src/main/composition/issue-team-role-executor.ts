import { Supervisor } from "../app/supervisor.js";
import type { ActorReceipt } from "../domain/issue-orchestration.js";
import type { IssueTeamRoleResult } from "../domain/issue-team.js";
import type { IssueTeamRoleExecutorPort } from "../ports/issue-team.js";
import { IssueActorResultError } from "../ports/issue-orchestration.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";
import type { PaidCallAllowance, PaidCallBudgetPort } from "../ports/paid-call-budget.js";

export interface IssueTeamRoleExecutorOptions {
  readonly agents: Readonly<Record<string, { readonly agentKind: import("../domain/issue-team.js").IssueTeamAgentKind; readonly adapter: SubAgentPort }>>;
  readonly diag: DiagnosticLog;
  readonly nowMs?: () => number;
  readonly budget?: PaidCallBudgetPort;
  readonly callAllowance?: PaidCallAllowance;
  /** Per-role liveness bound. The adapter receives a semantic cancel and performs bounded process teardown. */
  readonly roleDeadlineMs?: number;
}

/** Default liveness bound for one authored team role; callers may explicitly lower it for live profiles or tests. */
export const DEFAULT_ISSUE_TEAM_ROLE_DEADLINE_MS = 5 * 60_000;

export function makeIssueTeamRoleExecutor(options: IssueTeamRoleExecutorOptions): IssueTeamRoleExecutorPort {
  return {
    async execute(input) {
      const selected = options.agents[input.roleProfile.agentProfileId];
      if (!selected || selected.agentKind !== input.roleProfile.agentKind) throw new Error(`undeclared issue-team agent profile: ${input.roleProfile.agentProfileId}`);
      if (input.signal.aborted) throw input.signal.reason ?? new Error("issue-team role cancelled before dispatch");
      const startedAt = (options.nowMs ?? Date.now)();
      if (options.budget) {
        if (!options.callAllowance) throw new Error("issue-team paid-call allowance missing");
        options.budget.reserve({ idempotencyKey: input.stepId,
          expectedProvider: input.roleProfile.binding.provider, expectedModel: input.roleProfile.binding.model,
          ...(input.roleProfile.binding.reasoningEffort
            ? { expectedReasoningEffort: input.roleProfile.binding.reasoningEffort } : {}), ...options.callAllowance });
      }
      let text = ""; let pendingText = ""; let overflow = false;
      let report: import("../domain/orchestration.js").SupervisorReport | undefined;
      const supervisor = new Supervisor({
        subAgent: selected.adapter, diag: options.diag,
        egress: {
          event(event) {
            if (event.kind === "text_delta" && !overflow) {
              if (Buffer.byteLength(pendingText, "utf8") + Buffer.byteLength(event.text, "utf8") > 64 * 1024) { overflow = true; return; }
              pendingText += event.text;
            } else if (event.kind === "model_evidence" && pendingText.length > 0) {
              // Pi emits one model_evidence after each assistant message. Tool-using agents may narrate before
              // a tool call; only the final assistant message is the role-result contract payload.
              text = pendingText; pendingText = "";
            }
          },
          report(value) { report = value; },
        },
      });
      const deadlineMs = validDeadline(options.roleDeadlineMs) ? options.roleDeadlineMs : DEFAULT_ISSUE_TEAM_ROLE_DEADLINE_MS;
      const roleAbort = new AbortController();
      const forwardAbort = () => roleAbort.abort(input.signal.reason);
      if (input.signal.aborted) forwardAbort();
      else input.signal.addEventListener("abort", forwardAbort, { once: true });
      const deadline = setTimeout(() => roleAbort.abort(new Error(`issue-team role deadline exceeded: ${deadlineMs}ms`)), deadlineMs);
      try {
        await supervisor.run({ prompt: rolePrompt(input), workdir: input.worktreePath,
          model: input.roleProfile.binding.model, filesystemAccess: input.roleProfile.filesystemAccess }, roleAbort.signal);
      } finally {
        clearTimeout(deadline);
        input.signal.removeEventListener("abort", forwardAbort);
      }
      const evidence = report?.modelEvidence;
      if (!evidence?.provider || !evidence.selectedModel || !evidence.sessionId || !evidence.executionId) throw new Error("role receipt evidence unavailable");
      const receipt: ActorReceipt = {
        role: "worker", workerRole: roleFromStep(input.stepId),
        agentProfileId: input.roleProfile.agentProfileId, agentKind: input.roleProfile.agentKind,
        provider: evidence.provider, model: evidence.selectedModel,
        ...(evidence.reasoningEffort ? { reasoningEffort: evidence.reasoningEffort } : {}),
        sessionId: evidence.sessionId, executionId: evidence.executionId, idempotencyKey: input.stepId,
        ...(evidence.sessionEvidenceSource ? { sessionEvidenceSource: evidence.sessionEvidenceSource } : {}),
        tokenCountsAvailable: evidence.usageAvailable === true,
        inputTokens: evidence.usageAvailable === true ? evidence.inputTokens : 0,
        cachedInputTokens: evidence.usageAvailable === true ? evidence.cachedInputTokens ?? 0 : 0,
        outputTokens: evidence.usageAvailable === true ? evidence.outputTokens : 0,
        latencyMs: Math.max(0, (options.nowMs ?? Date.now)() - startedAt),
        ...(evidence.modelEvidenceSource ? { modelEvidenceSource: evidence.modelEvidenceSource } : {}),
        ...(evidence.piEstimatedCost !== undefined
          ? { estimatedCostUsd: evidence.piEstimatedCost, estimatedCostSource: "pi_catalog" as const } : {}),
        ...(evidence.gatewayBillingReceipts ? { gatewayBillingReceipts: evidence.gatewayBillingReceipts } : {}),
        cost: evidence.usageAvailable === true && evidence.measuredCostUsd !== undefined
          ? { state: "measured", usd: evidence.measuredCostUsd, source: evidence.gatewayBillingReceipts
            ? "gateway_versioned_customer_billing" : "role_adapter_priced_usage" }
          : { state: "unavailable", reason: "role adapter did not receive priced usage" },
      };
      if (evidence.provider !== input.roleProfile.binding.provider || evidence.selectedModel !== input.roleProfile.binding.model
        || (input.roleProfile.binding.reasoningEffort !== undefined && evidence.reasoningEffort !== input.roleProfile.binding.reasoningEffort)) {
        throw new IssueActorResultError("role model binding mismatch", receipt);
      }
      try { options.budget?.settle(input.stepId, receipt); }
      catch (error) { throw new IssueActorResultError(error instanceof Error ? error.message : "paid-call settlement failed", receipt); }
      if (pendingText.length > 0) text = pendingText;
      if (!report?.sessionOk || overflow) throw new IssueActorResultError(overflow
        ? "role assistant message exceeded 64 KiB"
        : `role session failed${report?.sessionEndReason ? `: ${report.sessionEndReason}` : ""}`, receipt);
      let result: IssueTeamRoleResult;
      try { result = parseRoleResult(text); }
      catch { throw new IssueActorResultError("role output was not one JSON object", receipt); }
      return { result, receipt };
    },
  };
}

function validDeadline(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 30 * 60_000;
}

function parseRoleResult(text: string): IssueTeamRoleResult {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)];
  if (fenced.length > 1) throw new Error("one role JSON object is required");
  const candidates = fenced.length === 1 ? [fenced[0]![1]!.trim()] : jsonObjectSuffixes(text.trim());
  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    try { parsed.push(JSON.parse(candidate)); } catch { /* candidate was not a complete JSON suffix */ }
  }
  if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object" || Array.isArray(parsed[0])) {
    throw new Error("one role JSON object is required");
  }
  return parsed[0] as IssueTeamRoleResult;
}

function jsonObjectSuffixes(text: string): string[] {
  const candidates: string[] = [];
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) candidates.push(text.slice(index));
  return candidates;
}

function rolePrompt(input: Parameters<IssueTeamRoleExecutorPort["execute"]>[0]): string {
  const role = roleFromStep(input.stepId);
  const decisions = { explorer: ["proceed"], implementer: ["implemented"], tester: ["pass", "fail"],
    reviewer: ["clean", "changes_requested"] } as const;
  const action = role === "implementer"
    ? "Use the available filesystem tools to perform the task. Treat exact syntax, exact bytes, paths, and negative constraints in the obligations as authoritative; do not substitute a merely equivalent implementation. Return implemented only after the requested artifact exists in the worktree."
    : role === "explorer"
      ? "Inspect the worktree with read-only tools before returning proceed."
      : "Inspect the current worktree with read-only tools and ground the decision in what actually exists; do not trust a prior role's claim or accept a merely equivalent implementation when an obligation specifies exact syntax, exact bytes, a path, or a negative constraint.";
  return `You are the ${role} ${input.roleProfile.filesystemAccess === "workspace_write" ? "implementation" : "read-only"} role for one coding issue.\n`
    + `${action}\n`
    + `Task: ${input.task}\nContext JSON: ${input.context}\n`
    + "After tool use, return only the contract object: no Markdown fence, prose, preamble, or additional keys. "
    + "Use version 1, a string summary, and a findings array whose items contain only non-empty string code and string message. "
    + `The role must be \"${role}\" and decision must be chosen from ${JSON.stringify(decisions[role])}: `
    + "{\"version\":1,\"role\":\"...\",\"decision\":\"...\",\"summary\":\"...\",\"findings\":[{\"code\":\"...\",\"message\":\"...\"}]}";
}
function roleFromStep(stepId: string): import("../domain/issue-team.js").IssueTeamRole {
  for (const role of ["explorer", "implementer", "tester", "reviewer"] as const) if (stepId.includes(`:${role}:`)) return role;
  throw new Error("invalid role step id");
}
