/**
 * Observability contracts — Logger, Tracer, Meter.
 *
 * All implementation packages MUST emit Events at major state transitions
 * per migration plan A.11 Observability meta-principle. Host constructs
 * concrete Logger/Tracer/Meter impls and injects via HostContext.
 *
 * Default impls live in @nextain/agent-observability (implementation
 * package, not this one). Contracts stay here (zero-runtime-dep).
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, err?: Error, ctx?: Record<string, unknown>): void;
  /** Fatal is reserved — emit before process termination. */
  fatal(msg: string, err?: Error, ctx?: Record<string, unknown>): void;
  /**
   * D06 (Slice 2 — opencode pattern). Returns a child logger with the
   * given tags merged into baseContext as `tags: [...]`. Optional —
   * implementations MAY return `this` if tagging is not supported.
   */
  tag?(...tags: string[]): Logger;
  /**
   * D06 (Slice 2). Start a named timer; returns an end function that
   * emits an info log with elapsed ms. Optional. Usage:
   *   const stop = logger.time?.("db.query");
   *   try { await query() } finally { stop?.() }
   */
  time?(label: string, ctx?: Record<string, unknown>): () => void;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface Span {
  setAttribute(key: string, value: unknown): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, parent?: SpanContext): Span;
}

export interface Counter {
  add(value: number, labels?: Record<string, string>): void;
}

export interface Histogram {
  record(value: number, labels?: Record<string, string>): void;
}

export interface Meter {
  counter(name: string): Counter;
  histogram(name: string): Histogram;
}
