import type { EffectiveLlmConfig, LlmRole, LlmRolesResolution } from "../domain/llm-roles.js";
import type { ToolProcessing } from "../domain/chat.js";
import type { TaskSpec, SupervisorReport } from "../domain/orchestration.js";
import type { SupervisorEgressPort } from "../ports/orchestration.js";
import type { SubAgentPort } from "../ports/orchestration.js";
import { makePiSubAgent, type SubAgentPiOptions } from "./subagent-pi.js";
import { makeCodexSubAgent, type SubAgentCodexOptions } from "./subagent-codex.js";
import { makeClaudeCodeSubAgent, type SubAgentClaudeCodeOptions } from "./subagent-claude-code.js";
import { makeGrokSubAgent, type SubAgentGrokOptions } from "./subagent-grok.js";
import { isNaiaPiModel } from "./naia-pi-provider.js";

/** The only roles that can run a Shell/Agent development task. */
export type PiDevelopmentRole = Extract<LlmRole, "expert" | "main" | "sub">;

export type PiRoleFactoryResult =
  | { readonly ok: true; readonly role: PiDevelopmentRole; readonly agent: SubAgentPort }
  | { readonly ok: false; readonly reason: string };

export interface ConfiguredRoleSubAgentOptions {
  readonly pi?: Omit<SubAgentPiOptions, "provider" | "model">;
  readonly codex?: Omit<SubAgentCodexOptions, "model">;
  readonly claude?: Omit<SubAgentClaudeCodeOptions, "model">;
  readonly grok?: Omit<SubAgentGrokOptions, "model">;
}

/** CLI worker table mapping supported development role providers to CLI adapters. */
export const CLI_ROLE_WORKERS = {
  codex: makeCodexSubAgent,
  claude: makeClaudeCodeSubAgent,
  grok: makeGrokSubAgent,
} as const;

export function cliWorkerForProvider(provider: string): keyof typeof CLI_ROLE_WORKERS | undefined {
  switch (provider.toLowerCase()) {
    case "codex":
      return "codex";
    case "claude-code-cli":
      return "claude";
    case "grok":
      return "grok";
    default:
      return undefined;
  }
}

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

function isConfiguredRoleSupported(config: EffectiveLlmConfig): boolean {
  if (cliWorkerForProvider(config.provider.value)) return true;
  const provider = config.provider.value.toLowerCase();
  if (!piProviderForRole(config.provider.value)) return false;
  if ((provider === "nextain" || provider === "naia") && !isNaiaPiModel(config.model.value)) return false;
  return true;
}

/** Trusted processing metadata for roles that can actually start through Pi or CLI workers. */
export function makePiRoleProcessingPlans(resolution: LlmRolesResolution | null): readonly ToolProcessing[] {
  if (!resolution?.ok) return [];
  return resolution.configs.flatMap((config) => {
    if (!( ["expert", "main", "sub"] as const).includes(config.role as PiDevelopmentRole)) return [];
    if (!isConfiguredRoleSupported(config)) return [];
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
			provider,
      model: config.model.value,
    }),
  };
}

/**
 * Creates the adapter selected by the configured role. CLI worker roles
 * (Codex, Claude, Grok) route to their respective authenticated CLI worker adapters
 * to retain local login/boundary; other permitted providers fallback to Pi as today.
 */
export function makeConfiguredRoleSubAgent(
  resolution: LlmRolesResolution | null,
  role: PiDevelopmentRole,
  options: ConfiguredRoleSubAgentOptions = {},
): PiRoleFactoryResult {
  if (!( ["expert", "main", "sub"] as const).includes(role)) {
    return { ok: false, reason: `LLM role '${role}' is not a Pi development role` };
  }
  if (!resolution?.ok) return { ok: false, reason: "LLM role configuration is missing or invalid" };
  const config = findRole(resolution, role);
  if (!config) return { ok: false, reason: `LLM role '${role}' is not configured` };

  const workerKey = cliWorkerForProvider(config.provider.value);
  if (workerKey === "codex") {
    return {
      ok: true,
      role,
      agent: CLI_ROLE_WORKERS.codex({ ...options.codex, model: config.model.value }),
    };
  }
  if (workerKey === "claude") {
    return {
      ok: true,
      role,
      agent: CLI_ROLE_WORKERS.claude({ ...options.claude, model: config.model.value }),
    };
  }
  if (workerKey === "grok") {
    return {
      ok: true,
      role,
      agent: CLI_ROLE_WORKERS.grok({ ...options.grok, model: config.model.value }),
    };
  }

  return makePiRoleSubAgent(resolution, role, options.pi);
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

export type PiRoleRunnerOptions =
  | ConfiguredRoleSubAgentOptions
  | Omit<SubAgentPiOptions, "provider" | "model">;

export function makePiRoleSupervisorRunner(
  resolution: LlmRolesResolution | null | (() => LlmRolesResolution | null),
  supervise: PiRoleSupervisor,
  options:
    | PiRoleRunnerOptions
    | ((role: PiDevelopmentRole) => PiRoleRunnerOptions) = {},
): (role: PiDevelopmentRole, task: TaskSpec, signal: AbortSignal, egress: SupervisorEgressPort) => Promise<PiRoleRunResult> {
  return async (role, task, signal, egress) => {
    const activeResolution = typeof resolution === "function" ? resolution() : resolution;
    const rawOptions = typeof options === "function" ? options(role) : options;
    const activeOptions: ConfiguredRoleSubAgentOptions =
      rawOptions && ("pi" in rawOptions || "codex" in rawOptions || "claude" in rawOptions || "grok" in rawOptions)
        ? (rawOptions as ConfiguredRoleSubAgentOptions)
        : { pi: rawOptions as Omit<SubAgentPiOptions, "provider" | "model"> };
    const selected = makeConfiguredRoleSubAgent(activeResolution, role, activeOptions);
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
