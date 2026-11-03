// UC5/UC13 / FR-AX-026.4 — opt-in gate at the execution boundary.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ToolCall, ToolSpec } from "../domain/chat.js";
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
  readonly validateApproval?: (request: AxApprovalRequest) => boolean;
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
        let approvalRequest: AxApprovalRequest | undefined;
        if (decision !== "allow") {
          const approve = decision === "code" ? deps.codeApproval : deps.conversationApproval;
          const request = Object.freeze({ call: snapshot, effects, requestId: opts.requestId, signal: opts.signal });
          approvalRequest = request;
          if (!approve || await awaitApproval(approve(request), opts.signal) !== true) return { output: "AX action was not approved", isError: true };
        }
        opts.signal?.throwIfAborted();
        if (approvalRequest && deps.validateApproval && !deps.validateApproval(approvalRequest)) {
          return { output: "AX approval is no longer current", isError: true };
        }
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

/** FR-AX-026.6: registration binds implementation and effects together. Never
 * populate this from MCP annotations, tool tiers, request JSON or model output. */
export interface AxEffectRegistration {
  readonly spec: ToolSpec;
  readonly classify: (call: ToolCall) => readonly AxEffect[];
  readonly execute: ToolExecutorPort["execute"];
}

export function makeAxEffectBroker(deps: {
  readonly registrations: readonly AxEffectRegistration[];
  readonly conversationApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  readonly codeApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  readonly validateApproval?: (request: AxApprovalRequest) => boolean;
  readonly diag: DiagnosticLog;
}): ToolExecutorPort {
  const registry = new Map<string, AxEffectRegistration>();
  for (const registration of deps.registrations) {
    const spec = deepFreeze(structuredClone(registration.spec));
    if (!spec.name || registry.has(spec.name)) throw new Error("AX duplicate or empty tool registration");
    // Capture function references now: later mutation cannot swap implementation.
    registry.set(spec.name, Object.freeze({ spec, classify: registration.classify, execute: registration.execute }));
  }
  const executor: ToolExecutorPort = {
    specs: () => [...registry.values()].map(({ spec }) => spec),
    execute: (call, opts) => {
      const entry = registry.get(call.name);
      return entry ? entry.execute(call, opts) : Promise.resolve({ output: "AX tool is not registered", isError: true });
    },
  };
  return makeAxPolicyToolExecutor({
    executor,
    classify: (call) => registry.get(call.name)?.classify(call) ?? [],
    conversationApproval: deps.conversationApproval,
    codeApproval: deps.codeApproval,
    validateApproval: deps.validateApproval,
    diag: deps.diag,
  });
}


/** FR-AX-026.8/9: process-local authority. Never serialize pending grants.
 * Only the authenticated host input adapter may call respond; this is not a tool.
 * A new process/store has no grants, including previously issued codes. */
export interface AxApprovalScope {
  readonly sessionId: string;
  readonly workspace: string;
  readonly provider: string;
  readonly policyRevision: string;
}
export interface AxApprovalCard {
  readonly proposalId: string;
  readonly requestId: string;
  readonly callId: string;
  readonly mode: "conversation" | "code";
  readonly expiresAt: number;
  readonly preview: string;
  readonly reviewedPlanDigest?: string;
}
export interface AxHumanApprovalInput extends AxApprovalScope {
  readonly proposalId: string;
  readonly origin: "human-text" | "human-voice";
  readonly text: string;
  readonly final: boolean;
  readonly confidence?: number;
}

export function makeAxHumanApprovalStore(deps: {
  readonly scope: () => AxApprovalScope;
  /** Trusted renderer must disclose full destination/payload; never model HTML.
   * Code mode requires a host-verified review/plan digest (not a model claim). */
  readonly describe: (request: AxApprovalRequest) => { preview: string; reviewedPlanDigest?: string };
  readonly present: (card: AxApprovalCard, code?: string) => void;
  readonly diag: DiagnosticLog;
  readonly ttlMs?: number;
  readonly now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 120_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 120_000) throw new Error("Invalid AX approval TTL");
  type Pending = {
    card: AxApprovalCard; scope: string; codeHash?: Uint8Array;
    settle: (approved: boolean) => void;
  };
  const pending = new Map<string, Pending>();
  let closed = false;
  let revision = 0;
  const grants = new WeakMap<AxApprovalRequest, { scope: string; expiresAt: number; revision: number }>();
  const scopeKey = (scope: AxApprovalScope) => {
    const fields = [scope.sessionId, scope.workspace, scope.provider, scope.policyRevision];
    if (fields.some((field) => typeof field !== "string" || !field)) throw new Error("Missing AX scope");
    return JSON.stringify(fields);
  };
  const hash = (text: string) => createHash("sha256").update(text).digest();
  function sweep() {
    let current: string;
    try { current = scopeKey(deps.scope()); } catch { current = ""; }
    for (const item of pending.values()) {
      if (item.scope !== current || now() >= item.card.expiresAt) item.settle(false);
    }
  }
  function requestApproval(request: AxApprovalRequest, mode: "conversation" | "code"): Promise<boolean> {
    sweep();
    if (closed || request.signal?.aborted || !request.requestId || axApprovalFor(request.effects) !== mode) return Promise.resolve(false);
    if (pending.size) {
      for (const entry of pending.values()) entry.settle(false);
      return Promise.resolve(false);
    }
    const scope = scopeKey(deps.scope());
    const description = deps.describe(request);
    if (!description.preview || (mode === "code" && !description.reviewedPlanDigest)) return Promise.resolve(false);
    // The immutable broker request remains captured until settlement. Each fresh
    // payload/plan is a new proposal; callers must invalidate on edit before UI update.
    const card: AxApprovalCard = Object.freeze({ proposalId: randomUUID(), requestId: request.requestId,
      callId: request.call.id, mode, expiresAt: now() + ttl, preview: description.preview,
      reviewedPlanDigest: mode === "code" ? description.reviewedPlanDigest : undefined });
    const code = mode === "code" ? randomBytes(16).toString("hex") : undefined;
    deps.diag.debug?.("AxHumanApprovalStore pending", { mode });
    return new Promise<boolean>((resolve) => {
      const abort = () => item.settle(false);
      const timer = setTimeout(abort, ttl);
      timer.unref?.();
      const item: Pending = { card, scope, codeHash: code ? hash(code) : undefined,
        settle(approved) {
          if (!pending.delete(card.proposalId)) return;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", abort);
          deps.diag.debug?.("AxHumanApprovalStore settled", { mode, approved });
          if (approved) grants.set(request, { scope, expiresAt: card.expiresAt, revision });
          resolve(approved);
        } };
      pending.set(card.proposalId, item);
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) { abort(); return; }
      try { deps.present(card, code); } catch { item.settle(false); }
    });
  }
  return {
    conversationApproval: (request: AxApprovalRequest) => requestApproval(request, "conversation"),
    codeApproval: (request: AxApprovalRequest) => requestApproval(request, "code"),
    /** A changed proposal, new user intent, workspace/provider switch or cancel
     * must invalidate before a replacement is shown. No remembered "yes". */
    validateApproval(request: AxApprovalRequest): boolean {
      const grant = grants.get(request);
      grants.delete(request);
      try { return !!grant && !closed && grant.revision === revision &&
        grant.scope === scopeKey(deps.scope()) && now() < grant.expiresAt && !request.signal?.aborted;
      } catch { return false; }
    },
    invalidate() { revision++; for (const item of pending.values()) item.settle(false); },
    dispose() { closed = true; revision++; for (const item of pending.values()) item.settle(false); },
    respond(input: AxHumanApprovalInput): boolean {
      sweep();
      const item = pending.get(input.proposalId);
      if (!item) return false;
      let inputScope: string;
      try { inputScope = scopeKey(input); } catch { return false; }
      if (inputScope !== item.scope) return false;
      // Multiple proposals never assign an ambiguous utterance to one of them.
      if (pending.size !== 1) { for (const entry of pending.values()) entry.settle(false); return false; }
      if ((input.origin !== "human-text" && input.origin !== "human-voice") || !input.final ||
          (input.origin === "human-voice" && (typeof input.confidence !== "number" ||
            !Number.isFinite(input.confidence) || input.confidence < 0.98 || input.confidence > 1))) {
        item.settle(false); return false;
      }
      const text = input.text.trim().normalize("NFC");
      const approved = item.card.mode === "conversation"
        ? /^(응|보내|그래|등록해)[.!。]?$/u.test(text)
        : input.origin === "human-text" && !!item.codeHash && timingSafeEqual(hash(text), item.codeHash);
      // Consume synchronously before resolving broker: races/replay cannot execute twice.
      item.settle(approved);
      return approved;
    },
  };
}

/** Host composition entry: keeps execution-time validation paired with input.
 * Do not pass just the boolean callbacks to a different executor. */
export function makeAxHumanEffectBroker(deps: Parameters<typeof makeAxHumanApprovalStore>[0] & {
  readonly registrations: readonly AxEffectRegistration[];
}) {
  const approvals = makeAxHumanApprovalStore(deps);
  return { approvals, executor: makeAxEffectBroker({ ...approvals, registrations: deps.registrations, diag: deps.diag }) };
}

/** FR-AX-026.11: host-only control lane. Tokens are object capabilities, never
 * wire fields. authenticate must verify connection identity and input provenance.
 * The host calls displayed only after render acknowledgement, beginInput at the
 * start of capture, and submit before any chat/model/memory dispatch. */
export function makeAxHostControlLane(deps: Parameters<typeof makeAxHumanApprovalStore>[0] & {
  readonly registrations: readonly AxEffectRegistration[];
  readonly authenticate: (evidence: unknown) => "human-text" | "human-voice" | undefined;
}) {
  deps.diag.debug?.("AxHostControlLane created", {});
  let card: AxApprovalCard | undefined;
  let displayed = false;
  let closed = false;
  const captures = new Map<object, { proposalId: string; origin: "human-text" | "human-voice" }>();
  const clear = () => { card = undefined; displayed = false; captures.clear(); };
  const broker = makeAxHumanEffectBroker({ ...deps, present(next, code) {
    clear(); card = next;
    deps.present(next, code);
  } });
  return {
    executor: broker.executor,
    displayed(proposalId: string) {
      if (closed || card?.proposalId !== proposalId) return false;
      displayed = true; return true;
    },
    beginInput(evidence: unknown): object | undefined {
      const origin = deps.authenticate(evidence);
      if (closed || !displayed || !card || !origin) return undefined;
      const token = Object.freeze({});
      captures.set(token, { proposalId: card.proposalId, origin });
      return token;
    },
    submit(token: object, input: { text: string; final: boolean; confidence?: number }): boolean {
      const capture = captures.get(token);
      captures.delete(token);
      if (closed || !capture || !displayed || card?.proposalId !== capture.proposalId) return false;
      const scope = deps.scope();
      clear();
      return broker.approvals.respond({ ...scope, text: input.text, final: input.final, confidence: input.confidence, proposalId: capture.proposalId, origin: capture.origin });
    },
    invalidate() { clear(); broker.approvals.invalidate(); },
    dispose() { closed = true; clear(); broker.approvals.dispose(); },
  };
}
