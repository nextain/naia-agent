/**
 * SessionLifecycle — state transitions for an agent session.
 *
 * Plan A.5: created → active → paused → resumed → closed | failed.
 * On `fatal` severity `ErrorEvent`, session transitions to `failed`.
 * `@nextain/agent-core` owns the transition logic; `alpha-memory` stores
 * session logs (no logic ownership).
 *
 * Sessions are identified by opaque `sessionId` strings; a host may run
 * multiple concurrent sessions (each with its own `HostContext`).
 */

import type { Event, ErrorEvent } from "./event.js";

export type SessionState =
  | "created"
  | "active"
  | "paused"
  | "resumed"
  | "closed"
  | "failed";

/** Terminal states — no further transitions. */
export type TerminalSessionState = "closed" | "failed";

export function isTerminalSessionState(s: SessionState): s is TerminalSessionState {
  return s === "closed" || s === "failed";
}

/** Valid transitions. Host / runtime MUST enforce; invalid transitions throw. */
export interface SessionTransition {
  from: SessionState;
  to: SessionState;
  /** Optional reason (shown in logs). */
  reason?: string;
  /** If transition is caused by a fatal ErrorEvent, reference it. */
  causedBy?: ErrorEvent;
}

export interface Session {
  id: string;
  state: SessionState;
  /** When session was created. */
  createdAt: number;
  /** Last state-change timestamp. */
  updatedAt: number;
  /** Optional human-readable title. */
  title?: string;
}

/** Event emitted when a session state transition happens. Runtime MUST
 *  emit this at every transition per A.11 Observability meta-principle. */
export interface SessionEvent extends Event {
  name: `session.${SessionState}` | "session.transition";
  sessionId: string;
  transition?: SessionTransition;
}

/** Static table of allowed transitions. Centralized so state machine code
 *  does not re-implement the rules. */
export const ALLOWED_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  created: ["active", "failed"],
  active: ["paused", "closed", "failed"],
  paused: ["resumed", "closed", "failed"],
  resumed: ["paused", "closed", "failed"],
  closed: [],
  failed: [],
};
