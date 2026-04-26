import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { redactString } from "@nextain/agent-observability";
import {
  type Capability,
  type NaiaStreamChunk,
  type SessionEndReason,
  type SpawnContext,
  type SubAgentAdapter,
  type SubAgentSession,
  type SubAgentStatus,
  type TaskSpec,
  UnsupportedError,
} from "@nextain/agent-types";

const DEFAULT_CAPABILITIES: readonly Capability[] = ["text_chat", "shell_exec"];
const HARD_KILL_DEADLINE_MS = 500; // P0-7 / contract C12

export interface ShellAdapterOptions {
  /** Executable to spawn (e.g., "opencode", "/usr/bin/echo"). */
  command: string;
  /** Argument builder. Default: [task.prompt]. */
  args?: (task: TaskSpec) => readonly string[];
  capabilities?: readonly Capability[];
  adapterId?: string;
  adapterName?: string;
  adapterVersion?: string;
  /** Override hard-kill deadline (ms). Default 500. Tests may shorten. */
  hardKillDeadlineMs?: number;
}

export class ShellAdapter implements SubAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly Capability[];
  readonly #opts: ShellAdapterOptions;

  constructor(opts: ShellAdapterOptions) {
    this.id = opts.adapterId ?? "shell";
    this.name = opts.adapterName ?? "ShellAdapter";
    this.version = opts.adapterVersion ?? "0.1.0";
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.#opts = opts;
  }

  async spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession> {
    // P0-6 / D09 — workdir resolve + sentinel
    const workdir = path.resolve(task.workdir);
    const args = this.#opts.args ? [...this.#opts.args(task)] : [task.prompt];
    const env: NodeJS.ProcessEnv = task.env ? { ...task.env } : {};
    const child = spawn(this.#opts.command, args, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new ShellSession({
      adapterId: this.id,
      child,
      workdir,
      ctx,
      taskSummary: `${this.#opts.command} ${args.join(" ")}`.slice(0, 200),
      hardKillDeadlineMs: this.#opts.hardKillDeadlineMs ?? HARD_KILL_DEADLINE_MS,
    });
  }
}

interface ShellSessionInit {
  adapterId: string;
  child: ChildProcess;
  workdir: string;
  ctx: SpawnContext;
  taskSummary: string;
  hardKillDeadlineMs: number;
}

class ShellSession implements SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  readonly startedAt: number;

  readonly #child: ChildProcess;
  readonly #ctx: SpawnContext;
  readonly #hardKillMs: number;
  #status: SubAgentStatus;
  #queue: NaiaStreamChunk[] = [];
  #waiters: Array<(value: IteratorResult<NaiaStreamChunk>) => void> = [];
  #ended = false;
  #closeListeners: Array<() => void> = [];

  constructor(init: ShellSessionInit) {
    this.id = `${init.adapterId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.adapterId = init.adapterId;
    this.startedAt = Date.now();
    this.#child = init.child;
    this.#ctx = init.ctx;
    this.#hardKillMs = init.hardKillDeadlineMs;
    this.#status = { phase: "starting" };

    // session_start (first chunk — contract C1)
    this.#emit({
      type: "session_start",
      sessionId: this.id,
      adapterId: init.adapterId,
      taskSummary: init.taskSummary,
      workdir: init.workdir,
    });
    this.#status = { phase: "running" };

    init.child.stdout?.on("data", (chunk: Buffer) => this.#emitText(chunk));
    init.child.stderr?.on("data", (chunk: Buffer) => this.#emitText(chunk));

    init.child.on("error", () => {
      if (this.#ended) return;
      this.#emitEnd("failed");
    });

    init.child.on("close", (code, signal) => {
      if (this.#ended) return;
      let reason: SessionEndReason;
      if (signal === "SIGKILL" || signal === "SIGTERM") reason = "cancelled";
      else if (code === 0) reason = "completed";
      else reason = "failed";
      this.#emitEnd(reason);
    });

    // signal forwarding
    if (init.ctx.signal.aborted) {
      void this.cancel("signal aborted at spawn");
    } else {
      init.ctx.signal.addEventListener(
        "abort",
        () => {
          void this.cancel("signal aborted");
        },
        { once: true },
      );
    }
  }

  #emitText(buf: Buffer): void {
    if (this.#ended) return;
    // P0-6 — secret redact mandatory at emit time
    const text = redactString(buf.toString("utf8"));
    if (text.length === 0) return;
    this.#emit({ type: "text_delta", sessionId: this.id, text });
  }

  #emitEnd(reason: SessionEndReason): void {
    if (this.#ended) return;
    this.#emit({ type: "session_end", sessionId: this.id, reason });
    this.#status = {
      phase: "ended",
      reason,
      durationMs: Date.now() - this.startedAt,
    };
    this.#ended = true;
    this.#drainWaiters();
    for (const cb of this.#closeListeners.splice(0)) cb();
  }

  #emit(chunk: NaiaStreamChunk): void {
    // Paranoid P0-2 fix — guard against late stdout/stderr races after
    // session_end already drained waiters. Without this, a queued chunk
    // could resolve a waiter that should have been done:true.
    if (this.#ended) return;
    if (this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      w({ value: chunk, done: false });
    } else {
      this.#queue.push(chunk);
    }
  }

  #drainWaiters(): void {
    while (this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      w({ value: undefined as never, done: true });
    }
  }

  events(): AsyncIterable<NaiaStreamChunk> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<NaiaStreamChunk> {
        return {
          async next(): Promise<IteratorResult<NaiaStreamChunk>> {
            if (self.#queue.length > 0) {
              return { value: self.#queue.shift()!, done: false };
            }
            if (self.#ended) {
              return { value: undefined as never, done: true };
            }
            return new Promise((resolve) => self.#waiters.push(resolve));
          },
        };
      },
    };
  }

  async cancel(reason?: string): Promise<void> {
    if (this.#ended) return;
    this.#emit({
      type: "interrupt",
      sessionId: this.id,
      reason: reason ?? "cancelled",
      mode: "hard_kill",
    });
    const sigterm = this.#child.kill("SIGTERM");
    if (!sigterm) {
      // already exited — close listener will emit session_end
      return;
    }
    // C12 — within hardKillMs we MUST emit session_end (or timer SIGKILL)
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.#ended) this.#child.kill("SIGKILL");
        resolve();
      }, this.#hardKillMs);
      this.#closeListeners.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async pause(): Promise<void> {
    throw new UnsupportedError(this.adapterId, "pause");
  }
  async resume(): Promise<void> {
    throw new UnsupportedError(this.adapterId, "resume");
  }
  async inject(_message: string): Promise<void> {
    throw new UnsupportedError(this.adapterId, "inject");
  }

  status(): SubAgentStatus {
    return this.#status;
  }

  // For debugging only — used by ctx.logger.fn
  // (No public API beyond the SubAgentSession contract.)
  /** @internal */
  get _ctxForTest(): SpawnContext {
    return this.#ctx;
  }
}
