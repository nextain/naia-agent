// UC5/UC13 / FR-AX-026.4 — opt-in gate at the execution boundary.
import type { ToolCall } from "../domain/chat.js";
import { axApprovalFor, type AxEffect } from "../domain/ax-approval-policy.js";
import type { DiagnosticLog, ToolExecutorPort } from "../ports/uc1.js";

export interface AxApprovalRequest {
  readonly call: ToolCall;
  readonly effects: readonly AxEffect[];
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

/** Callbacks are trusted host capabilities, not model tools or approval files.
 * The host must bind authenticated human input to this exact immutable call.
 * Code approval must additionally verify the reviewed plan and single-use code.
 */
export function makeAxPolicyToolExecutor(deps: {
  readonly executor: ToolExecutorPort;
  readonly classify: (call: ToolCall) => readonly AxEffect[];
  readonly conversationApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  readonly codeApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  readonly diag: DiagnosticLog;
}): ToolExecutorPort {
  return {
    // This wrapper owns all approvals; callers explicitly opt in instead of
    // asking once in ChatTurnHandler and a second time at this boundary.
    specs: () => deps.executor.specs().map((spec) => ({ ...spec, tier: "none" })),
    async execute(call, opts) {
      opts.signal?.throwIfAborted();
      try {
        if (!deps.executor.specs().some((spec) => spec.name === call.name)) {
          return { output: "AX tool is not registered", isError: true };
        }
        const snapshot = deepFreeze(structuredClone(call));
        const effects = Object.freeze([...deps.classify(snapshot)]);
        const decision = axApprovalFor(effects);
        // Payload, document names and destinations never enter diagnostics.
        deps.diag.debug?.("AxPolicyToolExecutor decision", { decision, effectCount: effects.length });
        if (decision === "deny") return { output: "AX action has no trusted effect classification", isError: true };
        if (decision !== "allow") {
          const approve = decision === "code" ? deps.codeApproval : deps.conversationApproval;
          const request = Object.freeze({ call: snapshot, effects, requestId: opts.requestId, signal: opts.signal });
          if (!approve || await awaitApproval(approve(request), opts.signal) !== true) return { output: "AX action was not approved", isError: true };
        }
        opts.signal?.throwIfAborted();
        return await deps.executor.execute(snapshot, opts);
      } catch {
        opts.signal?.throwIfAborted();
        return { output: "AX policy or tool execution failed", isError: true };
      }
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("AX calls must contain JSON data");
    }
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Uncooperative host callbacks cannot hold a cancelled turn open. Late results
 * are observed but never cause a second execution or an unhandled rejection. */
function awaitApproval(pending: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("aborted")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
