/**
 * @nextain/agent-protocol — wire protocol between host and naia-agent runtime.
 *
 * Zero runtime deps. Pure types + encode/decode helpers.
 *
 * The wire format is JSON Lines over stdio: one JSON object per line.
 * Each line is a `StdioFrame`. Framing is newline-delimited UTF-8.
 *
 * Version strategy (plan A.8):
 *   - protocol semver is independent from @nextain/agent-types semver
 *   - wire-format breaks bump protocol MAJOR, not types MAJOR
 *   - v1 is frozen at Phase 1 exit; v2 (planned) flip-day in Phase 2 X5
 */

export const PROTOCOL_VERSION = "1" as const;
/** Current wire-format version. Future versions will widen this union when
 *  shipped (Phase 2 X5 flip-day). Until then, accepting unknown versions
 *  would be silent corruption. */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Every wire message has this outer shape. */
export interface StdioFrame<P = unknown> {
  v: ProtocolVersion;
  /** Correlation id. Responses echo the request's `id`. */
  id: string;
  type: FrameType;
  payload: P;
}

export type FrameType =
  | "request"   // host → agent, awaiting response
  | "response"  // agent → host, terminal for a given request id
  | "event";    // either direction, fire-and-forget (stream chunks, logs, viseme, ...)

/** Parse a single JSON line into a StdioFrame. Throws on malformed JSON or
 *  on frames whose shape does not match. */
export function parseFrame<P = unknown>(line: string): StdioFrame<P> {
  const parsed: unknown = JSON.parse(line);
  if (!isFrame(parsed)) {
    throw new ProtocolError("malformed_frame", "Input does not match StdioFrame shape");
  }
  return parsed as StdioFrame<P>;
}

/** Serialize a StdioFrame to a single line (no trailing newline — caller adds). */
export function encodeFrame<P>(frame: StdioFrame<P>): string {
  return JSON.stringify(frame);
}

function isFrame(value: unknown): value is StdioFrame {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f["v"] === "string" &&
    typeof f["id"] === "string" &&
    (f["type"] === "request" || f["type"] === "response" || f["type"] === "event") &&
    "payload" in f
  );
}

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
