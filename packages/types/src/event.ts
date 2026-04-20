/**
 * Event — observability + state transition contract.
 *
 * All implementation packages MUST emit Events at major state transitions
 * (state change, boundary call, error). No logging = contract violation (A.11).
 *
 * ErrorEvent carries i18n-ready error codes; severity is distinct from
 * TierLevel (T0-T3) to avoid naming collision (A.5).
 */

export interface Event {
  /** Event name, e.g. "session.started", "tool.invoked", "llm.stream.chunk". */
  name: string;
  /** Milliseconds since epoch. */
  timestamp: number;
  /** Opaque trace id for correlation across async boundaries. */
  traceId?: string;
  /** Opaque span id, unique within a trace. */
  spanId?: string;
  /** Event-specific payload. */
  data?: Record<string, unknown>;
  /** Optional viseme stream marker for avatar lip-sync. */
  viseme?: string;
}

export type Severity = "info" | "warn" | "error" | "fatal";

export interface ErrorEvent extends Event {
  name: `error.${string}`;
  /** i18n-ready code. Host translates to user-visible text. */
  errorCode: string;
  severity: Severity;
  retryable: boolean;
  /** Optional stack/debug info — not for end users. */
  debug?: string;
}
