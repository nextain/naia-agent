import type { ToolProcessing } from "../domain/chat.js";
import type { EffectiveLlmConfig, LlmRole, LlmRolesResolution } from "../domain/llm-roles.js";
import type { SupervisorReport, TaskSpec } from "../domain/orchestration.js";
import type { SubAgentPort, SupervisorEgressPort } from "../ports/orchestration.js";
import { makeClaudeCodeSubAgent, type SubAgentClaudeCodeOptions } from "./subagent-claude-code.js";
import { makeCodexSubAgent, type SubAgentCodexOptions } from "./subagent-codex.js";
import { makeGrokSubAgent, type SubAgentGrokOptions } from "./subagent-grok.js";
import { isBuiltInLocalProvider } from "./user-owned-pi-provider.js";

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

export const SUPPORTED_NAIA_ROLE_MODELS = [
  "grok-4.3",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "solar-pro4",
  "solar-mini",
  "motif-3",
  "HCX-007",
  "HCX-DASH-002",
] as const;

export function normalizeSupportedNaiaRoleModel(model: string | undefined): string | undefined {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "dash-002") return "HCX-DASH-002";
  return SUPPORTED_NAIA_ROLE_MODELS.find((candidate) => candidate.toLowerCase() === lower);
}

export function isSupportedNaiaRoleModel(model: string | undefined): boolean {
  return normalizeSupportedNaiaRoleModel(model) !== undefined;
}

function isConfiguredRoleSupported(config: EffectiveLlmConfig): boolean {
  if (cliWorkerForProvider(config.provider.value) !== undefined) return true;
  const providerLower = config.provider.value.trim().toLowerCase();
  if (providerLower === "nextain" || providerLower === "naia") {
    return isSupportedNaiaRoleModel(config.model.value);
  }
  if (isBuiltInLocalProvider(providerLower)) {
    return Boolean(config.model.value.trim());
  }
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
 * worker adapter (`codex`, `claude-code-cli`, or `grok`). Account providers
 * (`naia`/`nextain`, `anthropic`) fail closed before spawn (B2 Option (나))
 * so Naia/Anthropic model IDs are never passed raw to OpenAI Codex CLI.
 */
export function makeRoleSubAgent(
  resolution: LlmRolesResolution | null,
  role: DevelopmentRole,
  options: SubAgentCodexOptions = {},
): RoleFactoryResult {
  const { model: _ignoredModel, ...callerOptions } = options;
  return resolveRoleSubAgent(resolution, role, { codex: callerOptions });
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
  const providerLower = config.provider.value.trim().toLowerCase();
  if (providerLower === "nextain" || providerLower === "naia") {
    const canonicalModel = normalizeSupportedNaiaRoleModel(config.model.value);
    if (!canonicalModel) {
      return { ok: false, reason: `Model '${config.model.value}' is not registered for Naia role '${role}'` };
    }
    return {
      ok: true,
      role,
      agent: makeCodexSubAgent({
        ...(options.codex ?? {}),
        provider: "naia",
        model: canonicalModel,
        ...(config.baseUrl?.value ? { baseUrl: config.baseUrl.value } : {}),
      }),
    };
  }
  if (isBuiltInLocalProvider(providerLower)) {
    return {
      ok: true,
      role,
      agent: makeCodexSubAgent({
        ...(options.codex ?? {}),
        provider: providerLower,
        model: config.model.value,
        ...(config.baseUrl?.value ? { baseUrl: config.baseUrl.value } : {}),
        ...(config.thinkingLevel?.value ? { thinkingLevel: config.thinkingLevel.value } : {}),
      }),
    };
  }
  if (providerLower === "anthropic") {
    return {
      ok: false,
      reason: `Account provider 'anthropic' (model '${config.model.value}') is not supported on the Codex role runner after Pi removal; configure 'claude-code-cli' for Claude CLI roles`,
    };
  }
  return { ok: false, reason: `Provider '${config.provider.value}' is not permitted for role '${role}'` };
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
        verification: {
          ok: false,
          checks: [{ name: "role", pass: false, details: reason }],
        },
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
