import type { EffectiveLlmConfig, LlmRole, LlmRolesResolution } from "../domain/llm-roles.js";
import type { TaskSpec, SupervisorReport } from "../domain/orchestration.js";
import type { SupervisorEgressPort } from "../ports/orchestration.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import { makePiSubAgent, type SubAgentPiOptions } from "./subagent-pi.js";

/** The only roles that can run a Shell/Agent development task. */
export type PiDevelopmentRole = Extract<LlmRole, "expert" | "main" | "sub">;

export type PiRoleFactoryResult =
  | { readonly ok: true; readonly role: PiDevelopmentRole; readonly agent: SubAgentPort }
  | { readonly ok: false; readonly reason: string };

function piProvider(provider: string): "openai" | "anthropic" | "naia" | undefined {
  switch (provider) {
    case "codex": return "openai";
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
  const provider = piProvider(config.provider.value);
  if (!provider) return { ok: false, reason: `Provider '${config.provider.value}' is not permitted for Pi role '${role}'` };
  return {
    ok: true,
    role,
    agent: makePiSubAgent({ ...options, provider, model: config.model.value }),
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
  resolution: LlmRolesResolution | null,
  supervise: PiRoleSupervisor,
  options: Omit<SubAgentPiOptions, "provider" | "model"> = {},
): (role: PiDevelopmentRole, task: TaskSpec, signal: AbortSignal, egress: SupervisorEgressPort) => Promise<PiRoleRunResult> {
  return async (role, task, signal, egress) => {
    const selected = makePiRoleSubAgent(resolution, role, options);
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
