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
