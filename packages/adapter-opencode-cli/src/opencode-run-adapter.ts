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
import { parseOpencodeEvent, type OpencodeEvent } from "./event-parser.js";
import { resolveOpencodeBin } from "./resolve-bin.js";

const HARD_KILL_DEADLINE_MS = 500; // P0-7 / contract C12
const DEFAULT_CAPS: readonly Capability[] = [
  "text_chat",
  "code_edit",
  "shell_exec",
  "git_ops",
  "test_run",
];

export interface OpencodeRunAdapterOptions {
  /** provider/model string passed via -m. Optional. */
  model?: string;
  /** opencode --dangerously-skip-permissions. Default false. */
  skipPermissions?: boolean;
  /** Override hardKillDeadlineMs. Default 500. */
  hardKillDeadlineMs?: number;
  /** Override binary resolution (testing). */
  resolveBin?: () => { command: string; prefixArgs: readonly string[] };
}

export class OpencodeRunAdapter implements SubAgentAdapter {
  readonly id = "opencode-cli";
  readonly name = "OpencodeRunAdapter";
  readonly version = "0.1.0";
  readonly capabilities = DEFAULT_CAPS;
  readonly #opts: OpencodeRunAdapterOptions;

  constructor(opts: OpencodeRunAdapterOptions = {}) {
    this.#opts = opts;
  }

  async health(): Promise<string | null> {
    try {
      const bin = (this.#opts.resolveBin ?? resolveOpencodeBin)();
      void bin;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession> {
    const bin = (this.#opts.resolveBin ?? resolveOpencodeBin)();
    const workdir = path.resolve(task.workdir);
    const args: string[] = [
      ...bin.prefixArgs,
      "run",
      "--format",
      "json",
      "--dir",
      workdir,
    ];
    if (this.#opts.model) {
      args.push("-m", this.#opts.model);
    }
    if (this.#opts.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    args.push(task.prompt);

    // P1-1 (Paranoid) — opencode CLI requires LLM provider credentials
    // (Z.AI/OpenRouter/Anthropic API keys) discovered through process.env
    // OR ~/.local/share/opencode/auth.json. We forward parent env so
    // existing user credentials work transparently. This is intentional.
    // Phase 2: secure mode will scrub known sensitive vars before forwarding.
    const env: NodeJS.ProcessEnv = task.env
      ? { ...process.env, ...task.env }
      : { ...process.env };
    const child = spawn(bin.command, args, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new OpencodeSession({
      child,
      workdir,
      ctx,
      taskSummary: `opencode run "${task.prompt.slice(0, 80)}"`,
      hardKillDeadlineMs: this.#opts.hardKillDeadlineMs ?? HARD_KILL_DEADLINE_MS,
    });
  }
}

interface OpencodeSessionInit {
  child: ChildProcess;
  workdir: string;
  ctx: SpawnContext;
  taskSummary: string;
  hardKillDeadlineMs: number;
}

class OpencodeSession implements SubAgentSession {
  readonly id: string;
  readonly adapterId = "opencode-cli";
  readonly startedAt: number;

  readonly #child: ChildProcess;
  readonly #ctx: SpawnContext;
  readonly #hardKillMs: number;
  #status: SubAgentStatus;
  #queue: NaiaStreamChunk[] = [];
  #waiters: Array<(value: IteratorResult<NaiaStreamChunk>) => void> = [];
  #ended = false;
  #stdoutBuf = "";
  #stderrBuf = "";
  #closeListeners: Array<() => void> = [];
  #liveTools = new Map<string, { tool: string; startedAt: number }>();

  constructor(init: OpencodeSessionInit) {
    this.id = `opencode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    init.child.stderr?.on("data", (chunk: Buffer) => this.#onStderr(chunk));

    init.child.on("error", () => {
      if (!this.#ended) this.#emitEnd("failed");
    });
    init.child.on("close", (code, signal) => {
      // flush any trailing partial line as best-effort
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
    // Paranoid P0-3 fix — single NDJSON line >64MiB is pathological
    // (malformed opencode output or DoS). Drop the in-flight buffer and
    // emit a fail-safe session_end to avoid OOM.
    if (this.#stdoutBuf.length > 64 * 1024 * 1024) {
      this.#stdoutBuf = "";
      if (!this.#ended) this.#emitEnd("failed");
    }
  }

  #onStderr(chunk: Buffer): void {
    if (this.#ended) return;
    // opencode logs to stderr when --print-logs; redact and buffer for now
    this.#stderrBuf += chunk.toString("utf8");
    if (this.#stderrBuf.length > 64 * 1024) {
      this.#stderrBuf = this.#stderrBuf.slice(-32 * 1024);
    }
  }

  #processLine(line: string): void {
    const event = parseOpencodeEvent(line);
    if (!event) return;
    this.#convertAndEmit(event);
  }

  #convertAndEmit(event: OpencodeEvent): void {
    switch (event.type) {
      case "step_start":
        this.#emit({
          type: "session_progress",
          sessionId: this.id,
          phase: "planning",
        });
        return;

      case "text": {
        const text = redactString(event.text ?? "");
        if (text.length === 0) return;
        this.#emit({ type: "text_delta", sessionId: this.id, text });
        return;
      }

      case "tool_use": {
        if (!event.tool) return;
        const { name, callId, status, input, output } = event.tool;
        if (status === "running") {
          this.#liveTools.set(callId, {
            tool: name,
            startedAt: Date.now(),
          });
          this.#emit({
            type: "tool_use_start",
            sessionId: this.id,
            toolUseId: callId,
            tool: name,
            input: redactObject(input),
          });
        } else if (status === "completed" || status === "failed") {
          // opencode often emits the tool_use only once with status=completed,
          // so we synthesize both start+end if start was not seen.
          const live = this.#liveTools.get(callId);
          if (!live) {
            this.#emit({
              type: "tool_use_start",
              sessionId: this.id,
              toolUseId: callId,
              tool: name,
              input: redactObject(input),
            });
          }
          const startedAt = live?.startedAt ?? Date.now();
          this.#liveTools.delete(callId);
          this.#emit({
            type: "tool_use_end",
            sessionId: this.id,
            toolUseId: callId,
            tool: name,
            result: redactObject(output),
            ok: status === "completed",
            elapsedMs: Date.now() - startedAt,
          });
        }
        return;
      }

      case "step_finish":
        // session_progress only — actual session_end is on child close
        this.#emit({
          type: "session_progress",
          sessionId: this.id,
          phase: "completed",
          ...(event.stepFinishReason !== undefined && {
            note: `step_finish: ${event.stepFinishReason}`,
          }),
        });
        return;

      case "unknown":
      default:
        return;
    }
  }

  #emit(chunk: NaiaStreamChunk): void {
    // Paranoid P0-2 fix — guard against late stdout chunk after session_end
    // already drained waiters. Without this, a queued chunk could resolve a
    // waiter that should have been done:true.
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
