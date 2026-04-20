// @naia-agent/core — runtime loop and dispatch (scaffold only).
// Consumes contracts from @naia-agent/types. See migration plan A.3/A.4.

// Re-export key contracts so hosts get a single import surface for the
// runtime-facing API. No runtime values yet.
export type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  MemoryProvider,
  Event,
  ErrorEvent,
} from "@naia-agent/types";
