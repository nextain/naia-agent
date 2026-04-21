// @nextain/agent-providers — LLMClient implementations.
// Currently: Anthropic. Future: OpenAI, Google, gateway (any-llm), mock.
//
// Each provider is a separate subpath to avoid pulling unused SDKs:
//   import { AnthropicClient } from "@nextain/agent-providers/anthropic";

export { AnthropicClient } from "./anthropic.js";
export type { AnthropicClientOptions } from "./anthropic.js";
