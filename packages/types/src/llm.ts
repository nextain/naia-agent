/**
 * LLMClient — the only contract through which naia-agent talks to LLMs.
 *
 * Implementations wrap providers directly (Anthropic/OpenAI/...), a routing
 * gateway (any-llm), or a mock (tests). Hosts construct and inject the
 * concrete client at startup; naia-agent never imports providers directly.
 */

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  /** Provider-specific prompt cache hint. Opaque to the caller. */
  cache?: PromptCacheHint;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LLMContentBlock[];
  /** When role="tool", identifies the originating tool call. */
  toolCallId?: string;
}

export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface PromptCacheHint {
  /** Indices into messages array that should be cached. Provider-specific semantics. */
  cachedIndices?: number[];
  ttlSeconds?: number;
}

export interface LLMResponse {
  id: string;
  model: string;
  content: LLMContentBlock[];
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage: LLMUsage;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type LLMStreamChunk =
  | { type: "start"; id: string; model: string }
  | { type: "delta"; delta: LLMContentBlock }
  | { type: "usage"; usage: Partial<LLMUsage> }
  | { type: "end"; stopReason: LLMResponse["stopReason"]; usage: LLMUsage };

export interface LLMClient {
  /** Single-shot generate. */
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** Streaming generate. Yields chunks until end. */
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}
