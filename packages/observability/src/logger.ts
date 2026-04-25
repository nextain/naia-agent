import type { Logger, LogLevel } from "@nextain/agent-types";

export interface ConsoleLoggerOptions {
  /** Minimum level to emit. Default "info". */
  level?: LogLevel;
  /** Write stream. Default process.stderr. */
  stream?: NodeJS.WritableStream;
  /** Optional static fields to include in every log entry. */
  baseContext?: Record<string, unknown>;
}

/** JSON-lines Logger writing to a stream (default: stderr).
 *  Each entry is one line: { ts, level, msg, ...ctx, err? }. */
export class ConsoleLogger implements Logger {
  readonly #level: LogLevel;
  readonly #stream: NodeJS.WritableStream;
  readonly #base: Record<string, unknown>;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#stream = options.stream ?? process.stderr;
    this.#base = options.baseContext ?? {};
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
    return new ConsoleLogger({
      level: this.#level,
      stream: this.#stream,
      baseContext: { ...this.#base, tags: [...existingTags, ...tags] },
    });
  }

  /** D06 — start a timer; the returned function emits an info log with elapsed ms. */
  time(label: string, ctx?: Record<string, unknown>): () => void {
    const start = Date.now();
    return () => {
      const elapsedMs = Date.now() - start;
      this.info(`${label}.elapsed`, { ...ctx, elapsedMs });
    };
  }

  #write(level: LogLevel, msg: string, ctx?: Record<string, unknown>, err?: Error): void {
    if (LEVELS[level] < LEVELS[this.#level]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.#base,
      ...ctx,
    };
    if (err) {
      entry["err"] = { name: err.name, message: err.message, stack: err.stack };
    }
    this.#stream.write(JSON.stringify(entry) + "\n");
  }
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
