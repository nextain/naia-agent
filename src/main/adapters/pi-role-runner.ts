import type { EffectiveLlmConfig, LlmRole, LlmRolesResolution } from "../domain/llm-roles.js";
import type { ToolProcessing } from "../domain/chat.js";
import type { TaskSpec, SupervisorReport } from "../domain/orchestration.js";
import type { SupervisorEgressPort } from "../ports/orchestration.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import { makePiSubAgent, type SubAgentPiOptions } from "./subagent-pi.js";
import { isNaiaPiAnalysisOnlyModel, isNaiaPiModel } from "./naia-pi-provider.js";

/** The only roles that can run a Shell/Agent development task. */
export type PiDevelopmentRole = Extract<LlmRole, "expert" | "main" | "sub">;

export type PiRoleFactoryResult =
  | { readonly ok: true; readonly role: PiDevelopmentRole; readonly agent: SubAgentPort }
  | { readonly ok: false; readonly reason: string };

export function piProviderForRole(provider: string): "openai-codex" | "anthropic" | "naia" | undefined {
  switch (provider) {
    case "codex": return "openai-codex";
    case "claude-code-cli":
    case "anthropic": return "anthropic";
    case "nextain":
    case "naia": return "naia";
    default: return undefined;
  }
}

function findRole(resolution: Extract<LlmRolesResolution, { ok: true }>, role: PiDevelopmentRole): EffectiveLlmConfig | undefined {
  return resolution.configs.find((config) => config.role === role);
}

/** Trusted processing metadata for roles that can actually start through Pi. */
export function makePiRoleProcessingPlans(resolution: LlmRolesResolution | null): readonly ToolProcessing[] {
  if (!resolution?.ok) return [];
  return resolution.configs.flatMap((config) => {
    if (!( ["expert", "main", "sub"] as const).includes(config.role as PiDevelopmentRole)) return [];
    if (!piProviderForRole(config.provider.value)) return [];
    const provider = config.provider.value.toLowerCase();
    if ((provider === "nextain" || provider === "naia") && !isNaiaPiModel(config.model.value)) return [];
    return [{
      workload: "sub_llm" as const,
      destination: "external_cloud" as const,
      provider: config.provider.value,
      model: config.model.value,
      when: { key: "agent", values: [config.role] },
    }];
  });
}

/**
 * Creates the Pi-only execution path used by Shell and Agent. The roster is
 * intentionally bypassed: no generic adapter can become a fallback here.
 */
export function makePiRoleSubAgent(
  resolution: LlmRolesResolution | null,
  role: PiDevelopmentRole,
  options: Omit<SubAgentPiOptions, "provider" | "model"> = {},
): PiRoleFactoryResult {
  if (!( ["expert", "main", "sub"] as const).includes(role)) {
    return { ok: false, reason: `LLM role '${role}' is not a Pi development role` };
  }
  if (!resolution?.ok) return { ok: false, reason: "LLM role configuration is missing or invalid" };
  const config = findRole(resolution, role);
  if (!config) return { ok: false, reason: `LLM role '${role}' is not configured` };
  const configuredProvider = config.provider.value.toLowerCase();
  if ((configuredProvider === "nextain" || configuredProvider === "naia") && !isNaiaPiModel(config.model.value)) {
    return { ok: false, reason: `Naia model '${config.model.value}' is not registered for Pi role '${role}'` };
  }
  const provider = piProviderForRole(config.provider.value);
  if (!provider) return { ok: false, reason: `Provider '${config.provider.value}' is not permitted for Pi role '${role}'` };
  return {
    ok: true,
    role,
    agent: makePiSubAgent({
      ...options,
      ...(isNaiaPiAnalysisOnlyModel(config.model.value) ? { noTools: true } : {}),
      provider,
      model: config.model.value,
    }),
  };
}

/**
 * Host-facing execution seam for configured development roles. It stays
 * independent from the generic roster, so no alternative adapter can be a fallback.
 */
export type PiRoleSupervisor = (
  agent: SubAgentPort,
  task: TaskSpec,
  signal: AbortSignal,
  egress: SupervisorEgressPort,
) => Promise<void>;

export interface PiRoleRunResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function makePiRoleSupervisorRunner(
  resolution: LlmRolesResolution | null | (() => LlmRolesResolution | null),
  supervise: PiRoleSupervisor,
  options: Omit<SubAgentPiOptions, "provider" | "model">
    | ((role: PiDevelopmentRole) => Omit<SubAgentPiOptions, "provider" | "model">) = {},
): (role: PiDevelopmentRole, task: TaskSpec, signal: AbortSignal, egress: SupervisorEgressPort) => Promise<PiRoleRunResult> {
  return async (role, task, signal, egress) => {
    const activeResolution = typeof resolution === "function" ? resolution() : resolution;
    const activeOptions = typeof options === "function" ? options(role) : options;
    const selected = makePiRoleSubAgent(activeResolution, role, activeOptions);
    if (!selected.ok) {
      egress.event({ kind: "session_end", ok: false, reason: selected.reason });
      egress.report({
        sessionOk: false,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        verification: { ok: false, checks: [{ name: "pi-role", pass: false, details: selected.reason }] },
      } satisfies SupervisorReport);
      return { ok: false, reason: selected.reason };
    }
    await supervise(selected.agent, task, signal, egress);
    return { ok: true };
  };
}
