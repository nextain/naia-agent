/**
 * Minimal JSON-RPC 2.0 client over child process stdio.
 *
 * Phase 2 Day 1.2 — handles ACP request/response correlation, notifications,
 * and bidirectional requests (server → client `session/request_permission`).
 *
 * P0-1 (Paranoid) — graceful shutdown on stdio EOF / process kill within
 * hardKillDeadlineMs (default 500ms, contract C12).
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface AcpRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpResponse {
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface AcpNotification {
  readonly method: string;
  readonly params?: unknown;
}

export type AcpHandler = (
  notification: AcpNotification,
) => void | Promise<void>;

/**
 * Bidirectional handler — invoked when server SENDS a request to us
 * (e.g., session/request_permission). Returns the response result.
 */
export type AcpServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export interface AcpClientOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  hardKillDeadlineMs?: number;
}

const HARD_KILL_DEADLINE_MS = 500;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class AcpClient {
  readonly #child: ChildProcess;
  readonly #hardKillMs: number;
  readonly #pending = new Map<number | string, PendingRequest>();
  readonly #handlers = new Map<string, AcpHandler>();
  #serverRequestHandler: AcpServerRequestHandler | undefined;
  #stdoutBuf = "";
  #nextId = 1;
  #closed = false;
  #closeWaiters: Array<() => void> = [];

  constructor(opts: AcpClientOptions) {
    this.#hardKillMs = opts.hardKillDeadlineMs ?? HARD_KILL_DEADLINE_MS;
    this.#child = spawn(opts.command, [...opts.args], {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child.stdout?.on("data", (c: Buffer) => this.#onStdout(c));
    this.#child.stderr?.on("data", (_c: Buffer) => {
      /* opencode logs to stderr when --print-logs; ignore for now */
    });
    this.#child.on("close", () => this.#handleClose());
    this.#child.on("error", () => this.#handleClose());
  }

  /** Send a JSON-RPC request and await its response. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) {
      throw new Error(`AcpClient closed; cannot send ${method}`);
    }
    const id = this.#nextId++;
    const req: AcpRequest = params !== undefined ? { id, method, params } : { id, method };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      this.#sendRaw({ jsonrpc: "2.0", ...req });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    const note: AcpNotification = params !== undefined ? { method, params } : { method };
    this.#sendRaw({ jsonrpc: "2.0", ...note });
  }

  /** Register a handler for an incoming notification (server → us). */
  onNotification(method: string, handler: AcpHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Register handler for incoming requests from server (e.g., session/request_permission). */
  onServerRequest(handler: AcpServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  /**
   * P0-5 / contract C12 — close stdin, wait for child to exit. If still alive
   * after hardKillMs, send SIGTERM then SIGKILL. Resolves when child exits.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#child.stdin?.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.#child.killed) {
          this.#child.kill("SIGTERM");
          setTimeout(() => {
            if (!this.#child.killed) this.#child.kill("SIGKILL");
          }, 100);
        }
      }, this.#hardKillMs);
      this.#closeWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** True after stdio close / process exit. */
  get closed(): boolean {
    return this.#closed;
  }

  // ─── internals ──────────────────────────────────────────────

  #sendRaw(obj: object): void {
    if (this.#closed) return;
    const json = JSON.stringify(obj) + "\n";
    try {
      this.#child.stdin?.write(json);
    } catch {
      this.#handleClose();
    }
  }

  #onStdout(chunk: Buffer): void {
    if (this.#closed) return;
    this.#stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.#stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuf.slice(0, nl);
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      this.#processLine(line);
    }
    // P0-3 (Paranoid Phase 1) carry-over — 64MiB cap on single line
    if (this.#stdoutBuf.length > 64 * 1024 * 1024) {
      this.#stdoutBuf = "";
      this.#handleClose();
    }
  }

  #processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string }; params?: unknown };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // silent drop (P1-2 — Phase 2 logger inject deferred to D35)
    }

    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-side request (id present + method present)
    if (msg.id !== undefined && msg.method !== undefined) {
      const handler = this.#serverRequestHandler;
      if (!handler) {
        this.#sendRaw({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `No handler for ${msg.method}` },
        });
        return;
      }
      void handler(msg.method, msg.params)
        .then((result) => {
          this.#sendRaw({ jsonrpc: "2.0", id: msg.id, result });
        })
        .catch((err: Error) => {
          this.#sendRaw({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: err.message },
          });
        });
      return;
    }

    // Notification (no id, method present)
    if (msg.method !== undefined && msg.id === undefined) {
      const h = this.#handlers.get(msg.method);
      if (h) {
        void Promise.resolve(h({ method: msg.method, params: msg.params })).catch(() => {
          /* ignore */
        });
      }
    }
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    // reject all pending
    for (const [, p] of this.#pending) {
      p.reject(new Error("ACP connection closed"));
    }
    this.#pending.clear();
    for (const cb of this.#closeWaiters.splice(0)) cb();
  }
}
