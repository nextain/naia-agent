/**
 * ApprovalBroker contract — tier-based user approval flow.
 *
 * Plan A.5 ApprovalFlow state machine:
 *   requested → pending → {approved | denied | timeout}
 *
 * The shell owns the UI (presenting the request to the user) and invokes
 * `ApprovalBroker.decide()`. The runtime owns the state — it holds the
 * pending ApprovalRequest and awaits the Promise.
 */

import type { ToolInvocation, TierLevel } from "./tool.js";

export interface ApprovalRequest {
  id: string;
  invocation: ToolInvocation;
  tier: TierLevel;
  /** Human-readable context — shown by shell in approval UI. */
  reason?: string;
  /**
   * Timeout after which the broker must resolve with `{ status: "timeout" }`.
   * Default policy lives in types-level constants (per plan A.5); hosts may
   * override per request.
   */
  timeoutMs?: number;
}

export type ApprovalStatus = "approved" | "denied" | "timeout";

export type ApprovalDecision =
  | { status: "approved"; at: number }
  | { status: "denied"; reason: string; at: number }
  | { status: "timeout"; at: number };

export interface ApprovalBroker {
  /** Resolve with a terminal decision. Never rejects on user denial — that is
   *  `{ status: "denied" }`. Rejects only on protocol faults. */
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Default timeout constants (plan A.5 — "types 기본 상수"). */
export const APPROVAL_DEFAULT_TIMEOUT_MS: Record<TierLevel, number> = {
  T0: 0,              // T0 never requires approval; timeout unused
  T1: 60_000,         // 60s
  T2: 120_000,        // 2min
  T3: 300_000,        // 5min
};
