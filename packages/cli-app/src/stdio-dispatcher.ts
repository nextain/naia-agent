/**
 * R4 Phase 4.1 Day 3.1 — StdioDispatcher (frame multiplexer).
 *
 * Adversarial review (Day 2 cumulative) P0-2 fix:
 *   IpcApprovalBroker는 approval frame만 처리. chat/usage/panel/audio 등
 *   다른 frame은 silent drop. → 단일 stdin reader + kind별 handler routing
 *   필요. 본 dispatcher가 모든 inbound frame을 받아서 등록된 handler에 routing.
 *
 * Adversarial review P0-1 fix:
 *   handshake 협상 미수행 시 frame 송신 가능. dispatcher가 first frame을
 *   handshake로 강제 + handshake_ack 응답 후에만 normal routing.
 *
 * Adversarial review P1-5 fix:
 *   multiple readline.createInterface(stdin) collision. dispatcher가 단일
 *   reader를 소유, 다른 컴포넌트는 register/handleFrame() interface만 사용.
 *
 * Architecture:
 *   stdin → readline → parseFrame → dispatcher.routeFrame()
 *     ├─ first frame: handshake → handshakeHandler
 *     ├─ kind="approval" → IpcApprovalBroker.handleFrame()
 *     ├─ kind="chat" → registered chat handler
 *     ├─ kind="panel_*" → registered panel handler
 *     └─ unknown → log + drop (P0-2 — no silent drop)
 */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  encodeFrame,
  parseFrame,
  type StdioFrame,
} from "@nextain/agent-protocol";
import { isValidKind } from "./ipc-approval-broker.js";

/** payload.kind whitelist 재export — dispatcher와 broker가 동일 SoT 사용. */
export { isValidKind };

/** Handler signature — dispatcher가 frame routing 시 호출. */
export type FrameHandler = (frame: StdioFrame) => void | Promise<void>;

export interface HandshakeRequestPayload {
  kind: "handshake";
  shellCapabilities?: string[];
  protocolVersion?: number;  // tolerant — host may send number, dispatcher compares to "1"
}

export interface HandshakeAckPayload {
  kind: "handshake_ack";
  protocolVersion: typeof PROTOCOL_VERSION;
  agentCapabilities: string[];
}

export interface StdioDispatcherOptions {
  /** stdin reader. Default process.stdin. Test usage: PassThrough/Readable. */
  in?: NodeJS.ReadableStream;
  /** stdout writer (handshake_ack 응답). Default process.stdout. */
  out?: NodeJS.WritableStream;
  /** Capabilities advertised back to shell on handshake_ack. */
  agentCapabilities?: string[];
  /**
   * If true, do NOT enforce handshake-first. Useful when host already negotiated
   * via different channel (e.g. CLI mode without stdio handshake). Default false.
   */
  skipHandshake?: boolean;
  /**
   * Handshake timeout (ms). If first frame is not handshake within timeout,
   * dispatcher emits stderr warning + continues (does not throw — graceful).
   * Default 10_000 (per Day 1.4 §3 — Flatpak cold start 8-10s 대비).
   */
  handshakeTimeoutMs?: number;
}

const DEFAULT_AGENT_CAPABILITIES = [
  "llm_chat",
  "tool_execution",
  "approval_request",
  "skill_list",
  "memory_recall_encode",
];

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export class StdioDispatcher {
  readonly #in: NodeJS.ReadableStream;
  readonly #out: NodeJS.WritableStream;
  readonly #agentCapabilities: string[];
  readonly #skipHandshake: boolean;
  readonly #handshakeTimeoutMs: number;
  readonly #handlers = new Map<string, FrameHandler>();
  #rl: readline.Interface | null = null;
  #closed = false;
  #handshakeComplete = false;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: StdioDispatcherOptions = {}) {
    this.#in = opts.in ?? process.stdin;
    this.#out = opts.out ?? process.stdout;
    // Adversarial Day 2 P1-B style guard — TTY collision prevention.
    if (this.#in === process.stdin && process.stdin.isTTY) {
      throw new Error(
        "StdioDispatcher requires non-TTY stdin (JSON frames). For terminal CLI, use Phase1Supervisor + CliApprovalBroker instead.",
      );
    }
    this.#agentCapabilities = opts.agentCapabilities ?? DEFAULT_AGENT_CAPABILITIES;
    this.#skipHandshake = opts.skipHandshake ?? false;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  /**
   * Register a handler for a specific payload.kind. Overrides previous registration
   * for the same kind.
   *
   * @param kind  payload.kind value (must be in ALLOWED_KINDS — silently drops registration if not).
   * @param handler  function called for each matching frame.
   */
  register(kind: string, handler: FrameHandler): void {
    if (!isValidKind(kind)) {
      process.stderr.write(`[StdioDispatcher] register rejected: invalid kind '${kind}'\n`);
      return;
    }
    this.#handlers.set(kind, handler);
  }

  /** Unregister a handler. */
  unregister(kind: string): void {
    this.#handlers.delete(kind);
  }

  /** Start reading frames from stdin. Idempotent. */
  start(): void {
    if (this.#rl !== null || this.#closed) return;
    this.#rl = readline.createInterface({
      input: this.#in,
      terminal: false,
    });
    this.#rl.on("line", (line: string) => {
      this.#onLine(line);
    });
    this.#rl.on("close", () => {
      this.close();
    });

    // If handshake required, set timeout watchdog.
    if (!this.#skipHandshake) {
      this.#handshakeTimer = setTimeout(() => {
        if (!this.#handshakeComplete) {
          process.stderr.write(
            `[StdioDispatcher] handshake timeout (${this.#handshakeTimeoutMs}ms) — proceeding without negotiation\n`,
          );
          this.#handshakeComplete = true;  // graceful degradation
          this.#handshakeTimer = null;
        }
      }, this.#handshakeTimeoutMs);
    } else {
      this.#handshakeComplete = true;
    }
  }

  /** Stop reading. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#handshakeTimer) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    if (this.#rl) {
      this.#rl.close();
      this.#rl = null;
    }
  }

  /** True after handshake_ack sent (or skipHandshake=true). */
  get handshakeComplete(): boolean {
    return this.#handshakeComplete;
  }

  /** Inject a frame manually (test usage). */
  routeFrame(frame: StdioFrame): void {
    this.#routeFrame(frame);
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: StdioFrame;
    try {
      frame = parseFrame(trimmed);
    } catch (err) {
      const msg = err instanceof ProtocolError ? `${err.code}: ${err.message}` : String(err);
      process.stderr.write(`[StdioDispatcher] frame parse error: ${msg}\n`);
      return;
    }
    this.#routeFrame(frame);
  }

  #routeFrame(frame: StdioFrame): void {
    if (this.#closed) return;

    const payload = frame.payload as { kind?: unknown };
    if (!payload || !isValidKind(payload.kind)) {
      process.stderr.write(
        `[StdioDispatcher] dropped frame with invalid kind: ${String(payload?.kind)} (id=${frame.id})\n`,
      );
      return;
    }

    const kind = payload.kind;

    // Handshake gate (P0-1 fix) — first frame must be handshake (unless skipped).
    if (!this.#handshakeComplete) {
      if (kind === "handshake") {
        this.#handleHandshake(frame);
        return;
      }
      // Non-handshake frame received before handshake_complete — log + drop.
      process.stderr.write(
        `[StdioDispatcher] frame received before handshake (kind=${kind}, id=${frame.id}) — dropped\n`,
      );
      return;
    }

    // Normal routing.
    const handler = this.#handlers.get(kind);
    if (!handler) {
      process.stderr.write(
        `[StdioDispatcher] no handler for kind: ${kind} (id=${frame.id}) — dropped\n`,
      );
      return;
    }

    try {
      const result = handler(frame);
      if (result instanceof Promise) {
        result.catch((err) => {
          process.stderr.write(
            `[StdioDispatcher] handler error (kind=${kind}, id=${frame.id}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
      }
    } catch (err) {
      process.stderr.write(
        `[StdioDispatcher] handler threw (kind=${kind}, id=${frame.id}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  #handleHandshake(frame: StdioFrame): void {
    const payload = frame.payload as HandshakeRequestPayload;

    // protocolVersion mismatch (P0-1 — Day 1.4 §3 spec)
    // Tolerant: payload.protocolVersion may be number (1) or string ("1") or absent.
    const versionRaw = payload.protocolVersion;
    const versionStr =
      versionRaw === undefined ? PROTOCOL_VERSION : String(versionRaw);
    if (versionStr !== PROTOCOL_VERSION) {
      process.stderr.write(
        `[StdioDispatcher] protocolVersion mismatch: shell=${versionStr} agent=${PROTOCOL_VERSION} — exiting\n`,
      );
      // Per Day 1.4 §3: agent stderr log + exit 3.
      process.exit(3);
    }

    // Send handshake_ack.
    // Day 3 review (P0-NEW-1) — use a freshly generated id rather than echoing
    // frame.id. Echoing the request id risks future collision if any other
    // frame (e.g. a stale request from a buggy/malicious host) reuses the same
    // id; dispatcher/broker would route by id only, ignoring the kind. By
    // assigning the ack a distinct id, we guarantee handshake_ack is uniquely
    // identifiable even if id reuse occurs upstream.
    const ackPayload: HandshakeAckPayload = {
      kind: "handshake_ack",
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: this.#agentCapabilities,
    };
    const ack: StdioFrame<HandshakeAckPayload> = {
      v: PROTOCOL_VERSION,
      id: `handshake-ack-${randomUUID()}`,
      type: "response",
      payload: ackPayload,
    };
    try {
      this.#out.write(`${encodeFrame(ack)}\n`);
    } catch (err) {
      process.stderr.write(
        `[StdioDispatcher] handshake_ack write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    this.#handshakeComplete = true;
    if (this.#handshakeTimer) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }
}
