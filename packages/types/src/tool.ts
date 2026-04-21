/**
 * ToolExecutor contract — runs individual tool invocations.
 *
 * Distinct from LLMContentBlock's `tool_use`/`tool_result` variants (which
 * carry tool calls inside LLM messages). This is the runtime-side
 * execution contract: given a ToolInvocation, run it and produce a
 * ToolExecutionResult.
 *
 * Implementations (see @nextain/agent-runtime) enforce tier policy and
 * approval flow via HostContext.approvals.
 */

export type TierLevel = "T0" | "T1" | "T2" | "T3";

/**
 * Tier semantics (A.5):
 *   T0 — read-only, no side effects (list files, ping). No approval, no audit.
 *   T1 — local side effects bounded to workspace (write file, run build).
 *         May require approval depending on host policy.
 *   T2 — local side effects with broader scope (shell exec, system-wide
 *         changes). Approval required; audit mandatory.
 *   T3 — external / irreversible (network calls with side effects, delete
 *         data). Approval required; audit mandatory; host may deny category-wide.
 */
export interface TierPolicy {
  tier: TierLevel;
  description: string;
  requiresApproval: boolean;
  auditRequired: boolean;
}

export interface ToolInvocation {
  /** Matches the `tool_use.id` that initiated this invocation. */
  id: string;
  name: string;
  input: unknown;
  tier: TierLevel;
  /** Originating session for correlation / audit. */
  sessionId?: string;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  /** Optional structured output (when caller wants more than a text blob). */
  data?: unknown;
}

export interface ToolExecutor {
  execute(invocation: ToolInvocation, signal?: AbortSignal): Promise<ToolExecutionResult>;
}
