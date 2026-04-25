import type { Logger, LogLevel, FnLogger } from "@nextain/agent-types";
import { redactObject } from "./redact.js";

export interface ConsoleLoggerOptions {
  /** Minimum level to emit. Default "info". */
  level?: LogLevel;
  /** Primary write stream. Default process.stderr. */
  stream?: NodeJS.WritableStream;
  /** Optional secondary stream (e.g. file). Both receive same entries. */
  secondaryStream?: NodeJS.WritableStream;
  /** Optional static fields to include in every log entry. */
  baseContext?: Record<string, unknown>;
  /** Apply secret-pattern redaction to all string values (Log Policy §5). Default true. */
  redact?: boolean;
}

/** JSON-lines Logger writing to a stream (default: stderr).
 *  Each entry is one line: { ts, level, msg, ...ctx, err? }. */
export class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #stream: NodeJS.WritableStream;
  readonly #secondaryStream: NodeJS.WritableStream | undefined;
  readonly #base: Record<string, unknown>;
  readonly #redact: boolean;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#stream = options.stream ?? process.stderr;
    this.#secondaryStream = options.secondaryStream;
    this.#base = options.baseContext ?? {};
    this.#redact = options.redact ?? true;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.#write("debug", msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.#write("info", msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.#write("warn", msg, ctx);
  }
  error(msg: string, err?: Error, ctx?: Record<string, unknown>): void {
    this.#write("error", msg, ctx, err);
  }
  fatal(msg: string, err?: Error, ctx?: Record<string, unknown>): void {
    this.#write("fatal", msg, ctx, err);
  }

  /** D06 — child logger with merged tags. opencode pattern. */
  tag(...tags: string[]): Logger {
    const existingTags = (this.#base["tags"] as string[] | undefined) ?? [];
    const opts: ConsoleLoggerOptions = {
      level: this.#level,
      stream: this.#stream,
      baseContext: { ...this.#base, tags: [...existingTags, ...tags] },
      redact: this.#redact,
    };
    if (this.#secondaryStream) opts.secondaryStream = this.#secondaryStream;
    return new ConsoleLogger(opts);
  }

  /** D06 — start a timer; the returned function emits an info log with elapsed ms. */
  time(label: string, ctx?: Record<string, unknown>): () => void {
    const start = Date.now();
    return () => {
      const elapsedMs = Date.now() - start;
      this.info(`${label}.elapsed`, { ...ctx, elapsedMs });
    };
  }

  /**
   * Log Policy §6 — function-scoped logger. Emits debug for enter / branch /
   * exit with consistent format + auto caller file:line. Captures elapsedMs
   * for perf tracking. No-op overhead when level > debug.
   */
  fn(name: string, args?: Record<string, unknown>): FnLogger {
    const debugEnabled = LEVELS["debug"] >= LEVELS[this.#level];
    if (!debugEnabled) return NOOP_FN_LOGGER;
    const start = Date.now();
    const caller = captureCaller();
    const baseCtx = caller ? { caller, ...args } : args;
    this.debug(`enter:${name}`, baseCtx);
    return {
      branch: (label, ctx) => {
        const branchCtx = caller ? { caller, ...ctx } : ctx;
        this.debug(`branch:${name}:${label}`, branchCtx);
      },
      exit: <T>(result?: T): T => {
        const exitCtx: Record<string, unknown> = {
          elapsedMs: Date.now() - start,
        };
        if (caller) exitCtx["caller"] = caller;
        if (result !== undefined) exitCtx["result"] = result;
        this.debug(`exit:${name}`, exitCtx);
        return result as T;
      },
    };
  }

  #write(level: LogLevel, msg: string, ctx?: Record<string, unknown>, err?: Error): void {
    if (LEVELS[level] < LEVELS[this.#level]) return;
    const rawEntry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.#base,
      ...ctx,
    };
    if (err) {
      rawEntry["err"] = { name: err.name, message: err.message, stack: err.stack };
    }
    const entry = this.#redact ? redactObject(rawEntry) : rawEntry;
    const line = JSON.stringify(entry) + "\n";
    this.#stream.write(line);
    if (this.#secondaryStream) this.#secondaryStream.write(line);
  }
}

const NOOP_FN_LOGGER: FnLogger = {
  branch: () => {},
  exit: <T>(result?: T): T => result as T,
};

/** Extract caller "file:line" from stack trace. Used by Logger.fn(). */
function captureCaller(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split("\n");
  // Stack: 0=Error, 1=captureCaller, 2=fn(), 3=actual caller
  const line = lines[3] ?? "";
  // Match patterns: "at fnName (file:line:col)" OR "at file:line:col"
  const m = line.match(/\(([^)]+):(\d+):\d+\)/) || line.match(/at\s+([^\s]+):(\d+):\d+/);
  if (!m) return undefined;
  const file = m[1] ?? "";
  const lineNo = m[2] ?? "";
  // Shorten: keep only last 2 path segments for brevity
  const shortFile = file.split("/").slice(-2).join("/");
  return `${shortFile}:${lineNo}`;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/** Discards all messages. For tests. */
export class SilentLogger implements Logger {
  debug(_msg: string, _ctx?: Record<string, unknown>): void {
    void _msg;
    void _ctx;
  }
  info(_msg: string, _ctx?: Record<string, unknown>): void {
    void _msg;
    void _ctx;
  }
  warn(_msg: string, _ctx?: Record<string, unknown>): void {
    void _msg;
    void _ctx;
  }
  error(_msg: string, _err?: Error, _ctx?: Record<string, unknown>): void {
    void _msg;
    void _err;
    void _ctx;
  }
  fatal(_msg: string, _err?: Error, _ctx?: Record<string, unknown>): void {
    void _msg;
    void _err;
    void _ctx;
  }
}
