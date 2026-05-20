// @nextain/agent-core — runtime loop and dispatch.
// Consumes contracts from @nextain/agent-types. See migration plan A.3/A.4.

export { Agent, stripRecallResidue } from "./agent.js";
export type { AgentOptions, AgentStreamEvent } from "./agent.js";
export { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.js";

// Re-export key contracts so hosts get a single import surface for the
// runtime-facing API.
export type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  MemoryProvider,
  Event,
  ErrorEvent,
  HostContext,
  HostContextCore,
  Session,
} from "@nextain/agent-types";
