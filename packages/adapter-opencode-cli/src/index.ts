/**
 * @nextain/agent-adapter-opencode-cli — Phase 1 Day 2
 *
 * Wraps `opencode-ai run --format json "<prompt>"` and converts the
 * NDJSON event stream into NaiaStreamChunk. ACP integration is Phase 2.
 *
 * Spec: docs/adapter-contract.md §3
 * Decision: D33 (R4 Week 0 spike)
 *
 * Discovered event types from spike (2026-04-26, opencode-ai@1.14.25):
 *   - step_start  — model turn begins
 *   - text        — text response part (.part.text)
 *   - tool_use    — tool call (.part.state.status: completed/running/failed)
 *   - step_finish — model turn ends (.part.reason: stop|tool-calls|...)
 */

export { OpencodeRunAdapter } from "./opencode-run-adapter.js";
export type { OpencodeRunAdapterOptions } from "./opencode-run-adapter.js";
export { resolveOpencodeBin } from "./resolve-bin.js";
export { parseOpencodeEvent } from "./event-parser.js";
export type { OpencodeEvent, OpencodeEventType } from "./event-parser.js";
