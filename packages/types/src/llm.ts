/**
 * LLMClient — the only contract through which naia-agent talks to LLMs.
 *
 * **Package policy**: ESM-only. Requires Node ≥ 22. CJS consumers are
 * unsupported; use dynamic `import()` if interop is needed.
 *
 * Implementations wrap providers directly (Anthropic/OpenAI/...), a routing
 * gateway (any-llm), or a mock (tests). Hosts construct and inject the
 * concrete client at startup; naia-agent never imports providers directly.
 *
 * Streaming follows the Anthropic SSE shape (start → content_block_start →
 * content_block_delta* → content_block_stop → usage → end). Provider
 * adapters are responsible for converting native streams into this shape;
 * blocks/deltas that don't map to a known variant should be dropped or
 * rewrapped, not passed through with a fallback union arm.
 */

export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMRequest {
  messages: LLMMessage[];
  /** Top-level system prompt (Anthropic-style). Separate from messages. */
  system?: string | LLMContentBlock[];
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
  role: Exclude<LLMRole, "system">;
  content: string | LLMContentBlock[];
  /** When role="tool", identifies the originating tool call. */
  toolCallId?: string;
  /** Optional message-level cache breakpoint hint. Cache from here backward. */
  cacheBreakpoint?: boolean;
}

/**
 * Content block discriminated union. Each variant is exhaustive on `type`.
 *
 * Provider adapters must convert native content into one of these variants.
 * Unknown provider blocks should be dropped at the adapter boundary — do
 * NOT introduce a permissive fallback here, as it breaks narrowing on all
 * known variants.
 */
export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      /**
       * Phase 5 Day 7.1 — Gemini 3 thinking-tool calling parity.
       * Optional opaque token returned by Gemini 3 thought-aware tool calls.
       * Must be echoed back in subsequent turns for accurate continuation.
       * Other providers ignore this field.
       */
      thoughtSignature?: string;
    }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; source: LLMImageSource };

export interface LLMImageSource {
  type: "base64" | "url";
  mediaType: string;
  data: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema. Shape deferred to Part B (may promote to JSONSchema7). */
  inputSchema: Record<string, unknown>;
}

export interface PromptCacheHint {
  /** Cache TTL suggestion in seconds. Provider-specific semantics. */
  ttlSeconds?: number;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "cancelled";

export interface LLMResponse {
  id: string;
  model: string;
  content: LLMContentBlock[];
  stopReason: StopReason;
  usage: LLMUsage;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Streaming delta — incremental content block fragments. Exhaustive on `type`.
 * Unknown provider deltas should be dropped at the adapter boundary.
 */
export type LLMContentDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partialJson: string };

export type LLMStreamChunk =
  | { type: "start"; id: string; model: string }
  | { type: "content_block_start"; index: number; block: LLMContentBlock }
  | { type: "content_block_delta"; index: number; delta: LLMContentDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "usage"; usage: Partial<LLMUsage> }
  | { type: "end"; stopReason: StopReason; usage: LLMUsage };

export interface LLMClient {
  /** Single-shot generate. */
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** Streaming generate. Yields chunks until "end". */
  stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}
