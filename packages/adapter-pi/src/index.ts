/**
 * @nextain/agent-adapter-pi
 *
 * Wraps `pi -p "<prompt>" --mode json --no-session` and converts the
 * NDJSON event stream into NaiaStreamChunk. Single-shot (no-session) mode only.
 *
 * Confirmed against pi@0.74.1 (print-mode.js + agent-session.js).
 *
 * Event mapping:
 *   session_start / agent_start → session_progress(planning)
 *   turn_start                  → session_progress(running)
 *   message_end                 → text_delta (content text blocks)
 *   tool_call                   → tool_use_start
 *   tool_result                 → tool_use_end
 *   turn_end / agent_end        → session_progress(completed)
 *   process close               → session_end
 */

export { PiRunAdapter } from "./pi-run-adapter.js";
export type { PiRunAdapterOptions } from "./pi-run-adapter.js";
export { resolvePiBin } from "./resolve-bin.js";
export { parsePiEvent, extractMessageText } from "./event-parser.js";
export type { PiEvent, PiEventType, PiMessage, PiMessageContent } from "./event-parser.js";
