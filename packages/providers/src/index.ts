// @nextain/agent-providers — LLMClient implementations.
// Currently: Anthropic. Future: OpenAI, Google, gateway (any-llm), mock.
//
// Each provider is a separate subpath to avoid pulling unused SDKs:
//   import { AnthropicClient } from "@nextain/agent-providers/anthropic";

export { AnthropicClient } from "./anthropic.js";
export type { AnthropicClientOptions } from "./anthropic.js";
export { createAnthropicVertexClient } from "./anthropic-vertex.js";
export type { AnthropicVertexClientOptions } from "./anthropic-vertex.js";
export { OpenAICompatClient } from "./openai-compat.js";
export type { OpenAICompatClientOptions } from "./openai-compat.js";
