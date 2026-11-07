import type { ToolProcessing } from "../domain/chat.js";
import type { EffectiveLlmConfig, LlmRole, LlmRolesResolution } from "../domain/llm-roles.js";
import { emptyVerification, type SupervisorReport, type TaskSpec } from "../domain/orchestration.js";
import type { SubAgentPort, SupervisorEgressPort } from "../ports/orchestration.js";
import { makeClaudeCodeSubAgent, type SubAgentClaudeCodeOptions } from "./subagent-claude-code.js";
import { makeCodexSubAgent, type SubAgentCodexOptions } from "./subagent-codex.js";
import { makeGrokSubAgent, type SubAgentGrokOptions } from "./subagent-grok.js";

export type DevelopmentRole = Extract<LlmRole, "expert" | "main" | "sub">;

export const CLI_ROLE_WORKERS = {
  codex: makeCodexSubAgent,
  claude: makeClaudeCodeSubAgent,
  grok: makeGrokSubAgent,
} as const;

export type CliRoleWorkerKind = keyof typeof CLI_ROLE_WORKERS;

export function cliWorkerForProvider(provider: string): CliRoleWorkerKind | undefined {
  switch (provider.trim().toLowerCase()) {
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

export type RoleFactoryResult =
  | { readonly ok: true; readonly role: DevelopmentRole; readonly agent: SubAgentPort }
  | { readonly ok: false; readonly reason: string };

const DEVELOPMENT_ROLES: readonly DevelopmentRole[] = ["expert", "main", "sub"];
const SUPPORTED_NAIA_ROLE_MODELS = new Set([
  "grok-4.3",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "solar-pro4",
  "solar-mini",
  "motif-3",
  "HCX-007",
  "HCX-DASH-002",
]);

function isSupportedNaiaRoleModel(model: string): boolean {
  return SUPPORTED_NAIA_ROLE_MODELS.has(model.trim());
}

function isConfiguredRoleSupported(config: EffectiveLlmConfig): boolean {
  if (cliWorkerForProvider(config.provider.value)) return true;
  const provider = config.provider.value.toLowerCase();
  if (provider === "anthropic") return true;
  if (provider === "nextain" || provider === "naia") return isSupportedNaiaRoleModel(config.model.value);
  return false;
}

function findRole(
  resolution: Extract<LlmRolesResolution, { ok: true }>,
  role: DevelopmentRole,
): EffectiveLlmConfig | undefined {
  return resolution.configs.find((config) => config.role === role);
}

/**
 * Publishes per-role sub-LLM processing disclosures so `ChatTurnHandler` can
 * authorize only the role selected for a given `delegate_agent` call.
 */
export function makeRoleProcessingPlans(resolution: LlmRolesResolution | null): readonly ToolProcessing[] {
  if (!resolution || !resolution.ok) return [];
  return resolution.configs.flatMap((config): readonly ToolProcessing[] => {
    if (!DEVELOPMENT_ROLES.includes(config.role as DevelopmentRole)) return [];
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

export interface RoleSubAgentOptions {
  readonly codex?: Omit<SubAgentCodexOptions, "model">;
  readonly claude?: Omit<SubAgentClaudeCodeOptions, "model">;
  readonly claudeCode?: Omit<SubAgentClaudeCodeOptions, "model">;
  readonly grok?: Omit<SubAgentGrokOptions, "model">;
}

/**
 * Resolves a configured development role (`expert`, `main`, `sub`) to its CLI
 * worker adapter, with Codex (`makeCodexSubAgent`) as the default core.
 */
export function makeRoleSubAgent(
  resolution: LlmRolesResolution | null,
  role: DevelopmentRole,
  options: SubAgentCodexOptions = {},
): RoleFactoryResult {
  if (!DEVELOPMENT_ROLES.includes(role)) {
    return { ok: false, reason: `Role '${String(role)}' is not a development role` };
  }
  if (!resolution || !resolution.ok) {
    return { ok: false, reason: "LLM role configuration is missing or invalid" };
  }
  const config = findRole(resolution, role);
  if (!config) {
    return { ok: false, reason: `Role '${role}' is missing from configuration` };
  }
  if (config.provider.value === "nextain" || config.provider.value === "naia") {
    if (!isSupportedNaiaRoleModel(config.model.value)) {
      return { ok: false, reason: `Model '${config.model.value}' is not registered for Naia role '${role}'` };
    }
  } else if (
    config.provider.value !== "codex"
    && config.provider.value !== "anthropic"
    && config.provider.value !== "claude-code-cli"
    && config.provider.value !== "grok"
  ) {
    return { ok: false, reason: `Provider '${config.provider.value}' is not permitted for role '${role}'` };
  }
  const { model: _ignoredModel, ...callerOptions } = options;
  return {
    ok: true,
    role,
    agent: makeCodexSubAgent({
      ...callerOptions,
      model: config.model.value,
    }),
  };
}

export function resolveRoleSubAgent(
  resolution: LlmRolesResolution | null,
  role: DevelopmentRole,
  options: RoleSubAgentOptions = {},
): RoleFactoryResult {
  if (!DEVELOPMENT_ROLES.includes(role)) {
    return { ok: false, reason: `Role '${String(role)}' is not a development role` };
  }
  if (!resolution || !resolution.ok) {
    return { ok: false, reason: "LLM role configuration is missing or invalid" };
  }
  const config = findRole(resolution, role);
  if (!config) {
    return { ok: false, reason: `Role '${role}' is missing from configuration` };
  }
  const worker = cliWorkerForProvider(config.provider.value);
  if (worker === "codex") {
    return {
      ok: true,
      role,
      agent: makeCodexSubAgent({
        ...(options.codex ?? {}),
        model: config.model.value,
      }),
    };
  }
  if (worker === "claude") {
    return {
      ok: true,
      role,
      agent: makeClaudeCodeSubAgent({
        ...(options.claude ?? options.claudeCode ?? {}),
        model: config.model.value,
      }),
    };
  }
  if (worker === "grok") {
    return {
      ok: true,
      role,
      agent: makeGrokSubAgent({
        ...(options.grok ?? {}),
        model: config.model.value,
      }),
    };
  }
  return makeRoleSubAgent(resolution, role, options.codex);
}

export const makeConfiguredRoleSubAgent = resolveRoleSubAgent;

export type RoleSupervisor = (
  subAgent: SubAgentPort,
  task: TaskSpec,
  signal: AbortSignal,
  egress: SupervisorEgressPort,
) => Promise<void>;

export interface RoleRunResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export type RoleRunnerOptions =
  | SubAgentCodexOptions
  | RoleSubAgentOptions;

export function makeRoleSupervisorRunner(
  resolution: LlmRolesResolution | null | (() => LlmRolesResolution | null),
  supervise: RoleSupervisor,
  options:
    | RoleRunnerOptions
    | ((role: DevelopmentRole) => RoleRunnerOptions) = {},
): (role: DevelopmentRole, task: TaskSpec, signal: AbortSignal, egress: SupervisorEgressPort) => Promise<RoleRunResult> {
  return async (role, task, signal, egress) => {
    const activeResolution = typeof resolution === "function" ? resolution() : resolution;
    const rawOptions = typeof options === "function" ? options(role) : options;
    const isComposite = "codex" in rawOptions || "claude" in rawOptions || "claudeCode" in rawOptions || "grok" in rawOptions;
    const normalizedOptions: RoleSubAgentOptions = isComposite
      ? (rawOptions as RoleSubAgentOptions)
      : { codex: rawOptions as SubAgentCodexOptions };
    const resolved = resolveRoleSubAgent(activeResolution, role, normalizedOptions);
    if (!resolved.ok) {
      const reason = resolved.reason;
      const report: SupervisorReport = {
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        verification: emptyVerification(),
        sessionOk: false,
      };
      egress.event({ kind: "session_end", ok: false, reason });
      egress.report(report);
      return { ok: false, reason };
    }
    const { model: _callerModel, ...restTask } = task;
    await supervise(resolved.agent, restTask, signal, egress);
    return { ok: true };
  };
}
