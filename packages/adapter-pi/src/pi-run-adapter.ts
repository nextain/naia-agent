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
import { extractMessageText, parsePiEvent, type PiEvent } from "./event-parser.js";
import { resolvePiBin } from "./resolve-bin.js";

const HARD_KILL_DEADLINE_MS = 500;
const DEFAULT_CAPS: readonly Capability[] = [
  "text_chat",
  "code_edit",
  "shell_exec",
  "git_ops",
  "test_run",
];

export interface PiRunAdapterOptions {
  /** Provider name passed via --provider. Optional. */
  provider?: string;
  /** Model string passed via --model. Optional. */
  model?: string;
  /** Override hardKillDeadlineMs. Default 500. */
  hardKillDeadlineMs?: number;
  /** Override binary resolution (testing). */
  resolveBin?: () => { command: string; prefixArgs: readonly string[] };
}

export class PiRunAdapter implements SubAgentAdapter {
  readonly id = "pi-cli";
  readonly name = "PiRunAdapter";
  readonly version = "0.1.0";
  readonly capabilities = DEFAULT_CAPS;
  readonly #opts: PiRunAdapterOptions;

  constructor(opts: PiRunAdapterOptions = {}) {
    this.#opts = opts;
  }

  async health(): Promise<string | null> {
    try {
      const bin = (this.#opts.resolveBin ?? resolvePiBin)();
      void bin;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession> {
    const bin = (this.#opts.resolveBin ?? resolvePiBin)();
    const workdir = path.resolve(task.workdir);

    // pi -p "<prompt>" --mode json --no-session [--provider <p>] [--model <m>]
    const args: string[] = [...bin.prefixArgs, "-p", task.prompt, "--mode", "json", "--no-session"];
    if (this.#opts.provider) {
      args.push("--provider", this.#opts.provider);
    }
    if (this.#opts.model) {
      args.push("--model", this.#opts.model);
    }

    // Forward parent env so pi can pick up API keys from process.env.
    const env: NodeJS.ProcessEnv = task.env
      ? { ...process.env, ...task.env }
      : { ...process.env };

    const child = spawn(bin.command, args, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new PiSession({
      child,
      workdir,
      ctx,
      taskSummary: `pi -p "${task.prompt.slice(0, 80)}"`,
      hardKillDeadlineMs: this.#opts.hardKillDeadlineMs ?? HARD_KILL_DEADLINE_MS,
    });
  }
}

interface PiSessionInit {
  child: ChildProcess;
  workdir: string;
  ctx: SpawnContext;
  taskSummary: string;
  hardKillDeadlineMs: number;
}

class PiSession implements SubAgentSession {
  readonly id: string;
  readonly adapterId = "pi-cli";
  readonly startedAt: number;

  readonly #child: ChildProcess;
  readonly #ctx: SpawnContext;
  readonly #hardKillMs: number;
  #status: SubAgentStatus;
  #queue: NaiaStreamChunk[] = [];
  #waiters: Array<(value: IteratorResult<NaiaStreamChunk>) => void> = [];
  #ended = false;
  #stdoutBuf = "";
  #closeListeners: Array<() => void> = [];
  #liveTools = new Map<string, { tool: string; startedAt: number }>();

  constructor(init: PiSessionInit) {
    this.id = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = Date.now();
    this.#child = init.child;
    this.#ctx = init.ctx;
    this.#hardKillMs = init.hardKillDeadlineMs;
    this.#status = { phase: "starting" };

    this.#emit({
      type: "session_start",
      sessionId: this.id,
      adapterId: this.adapterId,
      taskSummary: init.taskSummary,
      workdir: init.workdir,
    });
    this.#status = { phase: "running" };

    init.child.stdout?.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    init.child.stderr?.on("data", (_chunk: Buffer) => {
      // pi writes progress/debug to stderr — discard silently
    });

    init.child.on("error", () => {
      if (!this.#ended) this.#emitEnd("failed");
    });
    init.child.on("close", (code, signal) => {
      if (this.#stdoutBuf.length > 0) {
        this.#processLine(this.#stdoutBuf);
        this.#stdoutBuf = "";
      }
      if (this.#ended) return;
      let reason: SessionEndReason;
      if (signal === "SIGKILL" || signal === "SIGTERM") reason = "cancelled";
      else if (code === 0) reason = "completed";
      else reason = "failed";
      this.#emitEnd(reason);
    });

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

  #onStdout(chunk: Buffer): void {
    if (this.#ended) return;
    this.#stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.#stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuf.slice(0, nl);
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      this.#processLine(line);
    }
    // Guard against pathological single-line buffers (>64MiB)
    if (this.#stdoutBuf.length > 64 * 1024 * 1024) {
      this.#stdoutBuf = "";
      if (!this.#ended) this.#emitEnd("failed");
    }
  }

  #processLine(line: string): void {
    const event = parsePiEvent(line);
    if (!event) return;
    this.#convertAndEmit(event);
  }

  #convertAndEmit(event: PiEvent): void {
    switch (event.type) {
      case "session_start":
      case "agent_start":
        this.#emit({ type: "session_progress", sessionId: this.id, phase: "planning" });
        return;

      case "turn_start":
        this.#emit({ type: "session_progress", sessionId: this.id, phase: "executing" });
        return;

      case "message_end": {
        if (!event.message) return;
        const text = redactString(extractMessageText(event.message));
        if (text.length > 0) {
          this.#emit({ type: "text_delta", sessionId: this.id, text });
        }
        return;
      }

      case "tool_call": {
        if (!event.tool) return;
        const { name, callId, input } = event.tool;
        this.#liveTools.set(callId, { tool: name, startedAt: Date.now() });
        this.#emit({
          type: "tool_use_start",
          sessionId: this.id,
          toolUseId: callId,
          tool: name,
          input: redactObject(input),
        });
        return;
      }

      case "tool_result": {
        if (!event.tool) return;
        const { name, callId, result, isError } = event.tool;
        const live = this.#liveTools.get(callId);
        if (!live) {
          // pi sometimes emits tool_result without prior tool_call — synthesize start
          this.#emit({
            type: "tool_use_start",
            sessionId: this.id,
            toolUseId: callId,
            tool: name,
            input: redactObject(event.tool.input),
          });
        }
        const startedAt = live?.startedAt ?? Date.now();
        this.#liveTools.delete(callId);
        this.#emit({
          type: "tool_use_end",
          sessionId: this.id,
          toolUseId: callId,
          tool: name,
          result: redactObject(result),
          ok: isError !== true,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }

      case "turn_end":
        this.#emit({ type: "session_progress", sessionId: this.id, phase: "completed" });
        return;

      case "agent_end":
        // Actual session_end is emitted on process close
        this.#emit({ type: "session_progress", sessionId: this.id, phase: "completed" });
        return;

      case "unknown":
      default:
        return;
    }
  }

  #emit(chunk: NaiaStreamChunk): void {
    if (this.#ended) return;
    if (this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      w({ value: chunk, done: false });
    } else {
      this.#queue.push(chunk);
    }
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
    if (!sigterm) return;
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

  /** @internal */
  get _ctxForTest(): SpawnContext {
    return this.#ctx;
  }
}

function redactObject(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map(redactObject);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactObject(v);
    }
    return out;
  }
  return input;
}
