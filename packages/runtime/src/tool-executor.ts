/**
 * Runtime ToolExecutor helpers — tier gating + approval integration.
 *
 * Wraps a lower-level concrete tool executor (provided by the host — e.g.
 * naia-os' CommandExecutor from plan #198, or a process-level exec shim)
 * and enforces the tier policy via the injected ApprovalBroker.
 *
 * Phase 2 X2 scope. Real CommandExecutor implementation stays in naia-os
 * (Rust/shell) per plan A.6; runtime only provides the adapter pattern.
 */

import type {
  ApprovalBroker,
  TierLevel,
  ToolExecutor,
  ToolExecutionResult,
  ToolInvocation,
  Logger,
} from "@nextain/agent-types";

export interface GatedToolExecutorOptions {
  /** Concrete executor that performs the actual side effect. */
  inner: ToolExecutor;
  /** Broker that asks the host for user approval on T2/T3 calls. */
  approvals: ApprovalBroker;
  /** Optional logger. Emits tool.{start,approved,denied,end,error} events. */
  logger?: Logger;
  /** Tiers that require approval. Default: T2, T3. */
  requireApproval?: ReadonlySet<TierLevel>;
}

const DEFAULT_APPROVAL_TIERS: ReadonlySet<TierLevel> = new Set(["T2", "T3"]);

/**
 * Wraps a ToolExecutor and gates T2/T3 invocations through an ApprovalBroker.
 * T0/T1 pass through directly.
 */
export class GatedToolExecutor implements ToolExecutor {
  readonly #inner: ToolExecutor;
  readonly #approvals: ApprovalBroker;
  readonly #logger?: Logger;
  readonly #gatedTiers: ReadonlySet<TierLevel>;

  constructor(options: GatedToolExecutorOptions) {
    this.#inner = options.inner;
    this.#approvals = options.approvals;
    if (options.logger) this.#logger = options.logger;
    this.#gatedTiers = options.requireApproval ?? DEFAULT_APPROVAL_TIERS;
  }

  async execute(
    invocation: ToolInvocation,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    this.#logger?.info("tool.start", { name: invocation.name, tier: invocation.tier, id: invocation.id });

    if (this.#gatedTiers.has(invocation.tier)) {
      const decision = await this.#approvals.decide({
        id: invocation.id,
        invocation,
        tier: invocation.tier,
      });
      if (decision.status !== "approved") {
        this.#logger?.warn("tool.denied", { id: invocation.id, status: decision.status });
        return {
          content: `Tool "${invocation.name}" was not approved: ${decision.status}`,
          isError: true,
        };
      }
      this.#logger?.info("tool.approved", { id: invocation.id });
    }

    try {
      const result = await this.#inner.execute(invocation, signal);
      this.#logger?.info("tool.end", { id: invocation.id, isError: result.isError === true });
      return result;
    } catch (err) {
      this.#logger?.error("tool.error", err instanceof Error ? err : undefined, { id: invocation.id });
      return {
        content: `Tool "${invocation.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
