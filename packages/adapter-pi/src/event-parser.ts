/**
 * Parse pi `--mode json` NDJSON event stream.
 *
 * Events are emitted by pi's session.subscribe() listener and written as
 * `JSON.stringify(event)\n` to stdout (print-mode.js).
 *
 * Confirmed event types (agent-session.js + print-mode.js, pi@0.74.1):
 *   session_start  — header written before subscribe (reason: new|resume|fork)
 *   agent_start    — agent turn begins
 *   turn_start     — LLM turn begins
 *   message_start  — assistant message starting
 *   message_end    — assistant message complete (.message with .content[])
 *   tool_call      — tool being invoked (.toolName, .toolCallId, .input)
 *   tool_result    — tool completed (.toolName, .toolCallId, .content, .isError)
 *   turn_end       — LLM turn finished
 *   agent_end      — agent session complete (.messages)
 *   (others)       — compaction_*, auto_retry_*, session_info_changed, queue_update → ignored
 */

export type PiEventType =
  | "session_start"
  | "agent_start"
  | "turn_start"
  | "message_start"
  | "message_end"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "agent_end"
  | "unknown";

export interface PiMessageContent {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface PiMessage {
  readonly role?: string;
  readonly content?: PiMessageContent[];
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly [key: string]: unknown;
}

export interface PiEvent {
  readonly type: PiEventType;
  readonly raw: unknown;
  /** session_start: new|resume|fork */
  readonly reason?: string;
  /** message_end: full message */
  readonly message?: PiMessage;
  /** tool_call / tool_result */
  readonly tool?: {
    readonly name: string;
    readonly callId: string;
    readonly input?: unknown;
    readonly result?: unknown;
    readonly isError?: boolean;
  };
}

interface RawPiEvent {
  type?: string;
  reason?: string;
  message?: PiMessage;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** Returns null if line is empty or not valid JSON. */
export function parsePiEvent(line: string): PiEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawPiEvent;
  try {
    raw = JSON.parse(trimmed) as RawPiEvent;
  } catch {
    return null;
  }
  if (typeof raw.type !== "string") return null;

  const base: PiEvent = { type: classifyEventType(raw.type), raw };

  switch (raw.type) {
    case "session_start":
      return { ...base, reason: typeof raw.reason === "string" ? raw.reason : "new" };

    case "message_end": {
      if (raw.message && typeof raw.message === "object") {
        return { ...base, message: raw.message as PiMessage };
      }
      return base;
    }

    case "tool_call":
      return {
        ...base,
        tool: {
          name: typeof raw.toolName === "string" ? raw.toolName : "unknown",
          callId: typeof raw.toolCallId === "string" ? raw.toolCallId : "",
          input: raw.input,
        },
      };

    case "tool_result":
      return {
        ...base,
        tool: {
          name: typeof raw.toolName === "string" ? raw.toolName : "unknown",
          callId: typeof raw.toolCallId === "string" ? raw.toolCallId : "",
          input: raw.input,
          result: raw.content,
          isError: raw.isError === true,
        },
      };

    default:
      return base;
  }
}

function classifyEventType(t: string): PiEventType {
  switch (t) {
    case "session_start":
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_end":
    case "tool_call":
    case "tool_result":
    case "turn_end":
    case "agent_end":
      return t;
    default:
      return "unknown";
  }
}

/** Extract text from a pi message's content blocks. */
export function extractMessageText(message: PiMessage): string {
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}
