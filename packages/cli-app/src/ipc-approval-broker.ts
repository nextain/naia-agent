/**
 * R4 Phase 4.1 Day 2 — IpcApprovalBroker (stdio JSON-frame based).
 *
 * Decisions:
 * - D39 — handshake protocolVersion + capability negotiation (host enforces)
 * - D40 — tier별 default timeout (T1:60s/T2:120s/T3:300s), "always" 차단,
 *         cancel mechanism (modal SIGINT 시 approval_cancel event)
 * - P0-1 (Day 1.2) — StdioFrame v1 envelope + isValidKind whitelist
 * - P0-2 (Day 1.2) — fresh request per tier (no cached approval)
 * - P1-1 (Paranoid Day 1) — kind whitelist enforced
 *
 * Architecture:
 *   external naia-agent (this) ↔ stdio JSON frames ↔ host (Tauri shell)
 *
 * Flow:
 *   1. broker.decide(req) → write `request/approval` frame to output
 *   2. await `response/approval` frame matching id (timeout per tier)
 *   3. host (shell) shows PermissionModal → user clicks → write `response/approval`
 *   4. (optional) host writes `event/approval_cancel` (M1 — modal SIGINT)
 *   5. broker resolves with ApprovalDecision
 *
 * vs CliApprovalBroker:
 *   - CliApprovalBroker: readline y/N (terminal user)
 *   - IpcApprovalBroker: JSON frames (Tauri shell or other host)
 *
 * Spec: r4-phase4-day1-2-protocol-mapping.md §5/§6/§7
 */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  TierLevel,
} from "@nextain/agent-types";
import { APPROVAL_DEFAULT_TIMEOUT_MS } from "@nextain/agent-types";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
  parseFrame,
  type StdioFrame,
} from "@nextain/agent-protocol";

/** payload.kind whitelist (Paranoid P1-1 fix) — prototype pollution / injection 방지. */
const ALLOWED_KINDS = new Set<string>([
  // shell → agent (request)
  "chat", "cancel", "tool_direct", "tts", "skill_list",
  "memory_export", "memory_import",
  "panel_skills", "panel_skills_clear", "panel_install",
  // shell → agent (response/event)
  "approval", "panel_tool_result", "approval_cancel",
  // agent → shell (event)
  "chat_chunk", "audio", "usage", "tool_result", "chat_end",
  "error", "log", "token_warning", "ready",
  "panel_install_result", "panel_control",
  // agent → shell (request — agent solicits)
  "panel_tool_call",
  // agent → shell (response — to shell request)
  "memory_export_result", "memory_import_result", "skill_list_response",
  // handshake
  "handshake", "handshake_ack",
]);

export function isValidKind(kind: unknown): kind is string {
  if (typeof kind !== "string") return false;
  if (kind === "__proto__" || kind === "constructor" || kind === "prototype") return false;
  return ALLOWED_KINDS.has(kind);
}

/** Approval request payload (host에 전송). */
export interface ApprovalRequestPayload {
  kind: "approval";
  tier: TierLevel;
  toolName: string;
  toolArgs: unknown;
  summary: string;
  timeoutMs?: number;
  sessionId?: string;
}

/** Approval response payload (host로부터 수신). */
export interface ApprovalResponsePayload {
  kind: "approval";
  /** D40 — fresh request per tier; "always" 옵션 없음. */
  status: "approved" | "denied" | "timeout";
  reason?: string;
  at: number;
}

/** Approval cancel event payload (host로부터 — M1 modal SIGINT). */
export interface ApprovalCancelPayload {
  kind: "approval_cancel";
  reason: "user_sigint" | "modal_closed" | "agent_died" | "timeout_local";
}

export interface IpcApprovalBrokerOptions {
  /** stdout writer — frame outgoing. Default process.stdout. */
  out?: NodeJS.WritableStream;
  /** stdin reader — frame incoming. Default process.stdin. */
  in?: NodeJS.ReadableStream;
  /**
   * Default timeout override per tier (ms). 미지정 시 APPROVAL_DEFAULT_TIMEOUT_MS 사용.
   * Useful for testing.
   */
  defaultTimeoutMs?: Partial<Record<TierLevel, number>>;
  /** Optional sessionId for correlation. */
  sessionId?: string;
  /**
   * Day 3 (adversarial P1-5 fix) — operating mode.
   * - "standalone" (default): broker owns its own readline reader. Use when no
   *   StdioDispatcher is in play (legacy / direct test usage).
   * - "dispatched": broker does NOT create a readline reader. A StdioDispatcher
   *   (or other coordinator) must call `broker.handleFrame()` for inbound frames.
   *   Eliminates multi-reader collision when other components share stdin.
   */
  mode?: "standalone" | "dispatched";
}

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  tier: TierLevel;
}

/**
 * D40 IpcApprovalBroker — host가 stdio JSON frame으로 approval UI 처리.
 *
 * - tier별 default timeout 자동 적용 (T1:60s/T2:120s/T3:300s)
 * - "always" 옵션 자동 차단 (status union 자체가 "approved"|"denied"|"timeout")
 * - approval_cancel event 수신 시 pending Promise를 denied로 settle
 * - 동시 multiple approval 지원 (id 기반 routing, 내부 Map)
 */
export class IpcApprovalBroker implements ApprovalBroker {
  readonly #out: NodeJS.WritableStream;
  readonly #in: NodeJS.ReadableStream;
  readonly #defaultTimeoutMs: Record<TierLevel, number>;
  readonly #sessionId?: string;
  readonly #mode: "standalone" | "dispatched";
  readonly #pending = new Map<string, PendingApproval>();
  #rl: readline.Interface | null = null;
  #closed = false;

  constructor(opts: IpcApprovalBrokerOptions = {}) {
    this.#out = opts.out ?? process.stdout;
    this.#in = opts.in ?? process.stdin;
    this.#mode = opts.mode ?? "standalone";
    // Paranoid P1-B (Day 2 review) — TTY readline collision guard.
    // Only standalone mode creates a reader; in dispatched mode, the dispatcher
    // owns the reader and broker only receives via handleFrame().
    if (
      this.#mode === "standalone" &&
      this.#in === process.stdin &&
      process.stdin.isTTY
    ) {
      throw new Error(
        "IpcApprovalBroker (standalone) requires non-TTY stdin (JSON frames). For terminal use, instantiate CliApprovalBroker. For shared stdin, use mode: 'dispatched' with StdioDispatcher.",
      );
    }
    this.#defaultTimeoutMs = {
      T0: opts.defaultTimeoutMs?.T0 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T0,
      T1: opts.defaultTimeoutMs?.T1 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T1,
      T2: opts.defaultTimeoutMs?.T2 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T2,
      T3: opts.defaultTimeoutMs?.T3 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T3,
    };
    if (opts.sessionId !== undefined) {
      this.#sessionId = opts.sessionId;
    }
    if (this.#mode === "standalone") {
      this.#startReader();
    }
  }

  /**
   * Day 3 — wire this broker into a StdioDispatcher (mode "dispatched").
   * Registers handleFrame() for both `approval` (response) and `approval_cancel`
   * (event) kinds.
   *
   * Usage:
   *   const dispatcher = new StdioDispatcher();
   *   const broker = new IpcApprovalBroker({ out: ..., mode: "dispatched" });
   *   broker.attachToDispatcher(dispatcher);
   *   dispatcher.start();
   */
  attachToDispatcher(dispatcher: { register: (kind: string, h: (f: StdioFrame) => void) => void }): void {
    if (this.#mode !== "dispatched") {
      throw new Error(
        "attachToDispatcher() requires mode: 'dispatched'. Current mode: " + this.#mode,
      );
    }
    const handler = (f: StdioFrame): void => this.handleFrame(f);
    dispatcher.register("approval", handler);
    dispatcher.register("approval_cancel", handler);
  }

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.#closed) {
      return { status: "denied", reason: "broker closed", at: Date.now() };
    }

    const tier = request.tier;
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs[tier];
    const id = request.id || randomUUID();

    const payload: ApprovalRequestPayload = {
      kind: "approval",
      tier,
      toolName: request.invocation.name,
      toolArgs: request.invocation.input,
      summary: request.reason ?? `${request.invocation.name} requires approval`,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
    };

    const frame: StdioFrame<ApprovalRequestPayload> = {
      v: PROTOCOL_VERSION,
      id,
      type: "request",
      payload,
    };

    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      // Architect/Paranoid P1 (Day 2 review) — settle() is idempotent.
      // Multiple paths can race to settle: timeout timer fires, response frame
      // arrives, approval_cancel event arrives, broker.close() invoked.
      // The `settled` flag ensures only the first wins; subsequent calls drop
      // safely. Map.delete is also idempotent — double-cleanup is harmless.
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        const pending = this.#pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pending.delete(id);
        }
        resolve(decision);
      };

      // T0 통과 — never requires approval
      if (tier === "T0") {
        settle({ status: "approved", at: Date.now() });
        return;
      }

      const timer = setTimeout(() => {
        settle({ status: "timeout", at: Date.now() });
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: settle,
        timer,
        tier,
      });

      try {
        this.#out.write(`${encodeFrame(frame)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        settled = true;
        resolve({
          status: "denied",
          reason: `frame write failed: ${err instanceof Error ? err.message : String(err)}`,
          at: Date.now(),
        });
      }
    });
  }

  /** Inbound frame 처리 — response/event 매핑. */
  handleFrame(frame: StdioFrame): void {
    if (this.#closed) return;
    const payload = frame.payload as { kind?: unknown };
    if (!payload || !isValidKind(payload.kind)) {
      // Drop frames with invalid kinds — security boundary.
      return;
    }

    if (frame.type === "response" && payload.kind === "approval") {
      const resPayload = payload as unknown as ApprovalResponsePayload;
      const pending = this.#pending.get(frame.id);
      if (!pending) {
        // Stale response (id not in pending Map). Paranoid P2-B (Day 2) —
        // log to stderr for shell-side debug visibility (silent drops mask
        // duplicate/out-of-order host responses).
        process.stderr.write(
          `[IpcApprovalBroker] stale approval response dropped (id=${frame.id}, no pending)\n`,
        );
        return;
      }
      const status = resPayload.status;
      // D40 — only approved/denied/timeout valid; "always" or anything else is dropped
      // (pending stays, will eventually timeout). This enforces fresh-per-tier.
      if (status === "approved") {
        clearTimeout(pending.timer);
        this.#pending.delete(frame.id);
        pending.resolve({ status: "approved", at: resPayload.at ?? Date.now() });
      } else if (status === "denied") {
        clearTimeout(pending.timer);
        this.#pending.delete(frame.id);
        pending.resolve({
          status: "denied",
          reason: resPayload.reason ?? "user denied",
          at: resPayload.at ?? Date.now(),
        });
      } else if (status === "timeout") {
        clearTimeout(pending.timer);
        this.#pending.delete(frame.id);
        pending.resolve({ status: "timeout", at: resPayload.at ?? Date.now() });
      } else {
        // Invalid status (e.g. "always", typo) — log to stderr, drop.
        // Pending stays — eventually times out via timer.
        // Paranoid P2-A (Day 2 review): include payload snippet.
        // Adversarial Day 2 P2-2 (Day 3 fix): redact `reason` field (may carry secrets).
        const safePayload = { ...resPayload, reason: "***redacted***" };
        const payloadSnippet = JSON.stringify(safePayload).slice(0, 200);
        process.stderr.write(
          `[IpcApprovalBroker] dropped invalid approval status: ${String(status)} (id=${frame.id}, payload=${payloadSnippet})\n`,
        );
      }
      return;
    }

    if (frame.type === "event" && payload.kind === "approval_cancel") {
      const cancelPayload = payload as unknown as ApprovalCancelPayload;
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(frame.id);
      pending.resolve({
        status: "denied",
        reason: `cancelled: ${cancelPayload.reason}`,
        at: Date.now(),
      });
      return;
    }
  }

  /**
   * Shutdown — pending approvals를 모두 denied (broker_closed) 처리.
   * Use when agent is shutting down.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#rl) {
      this.#rl.close();
      this.#rl = null;
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        status: "denied",
        reason: "broker closed",
        at: Date.now(),
      });
      this.#pending.delete(id);
    }
  }

  /** in-memory pending count — for diagnostics / queue inspection (M2). */
  pendingCount(): number {
    return this.#pending.size;
  }

  #startReader(): void {
    this.#rl = readline.createInterface({
      input: this.#in,
      terminal: false,
    });
    this.#rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const frame = parseFrame(trimmed);
        this.handleFrame(frame);
      } catch (err) {
        // Malformed frame — log via stderr, do not crash.
        if (err instanceof ProtocolError) {
          process.stderr.write(`[IpcApprovalBroker] ${err.code}: ${err.message}\n`);
        } else {
          process.stderr.write(
            `[IpcApprovalBroker] frame parse error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    });
    this.#rl.on("close", () => {
      // Input stream ended — settle any pending as denied.
      this.close();
    });
  }
}
