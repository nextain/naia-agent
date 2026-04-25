/**
 * AnthropicClient — LLMClient implementation over @anthropic-ai/sdk.
 *
 * Usage:
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { AnthropicClient } from "@nextain/agent-providers/anthropic";
 *
 *   const client = new AnthropicClient(new Anthropic({ apiKey }), {
 *     defaultModel: "claude-opus-4-7",
 *   });
 *
 * `@anthropic-ai/sdk` is a peerDependency — the host installs and injects.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  LLMClient,
  LLMContentBlock,
  LLMContentDelta,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMUsage,
  Logger,
  StopReason,
  ToolDefinition,
} from "@nextain/agent-types";

export interface AnthropicClientOptions {
  defaultModel?: string;
  defaultMaxTokens?: number;
  logger?: Logger;
}

export class AnthropicClient implements LLMClient {
  readonly #sdk: Anthropic;
  readonly #defaultModel: string;
  readonly #defaultMaxTokens: number;
  readonly #logger: Logger | undefined;

  constructor(sdk: Anthropic, options: AnthropicClientOptions = {}) {
    this.#sdk = sdk;
    this.#defaultModel = options.defaultModel ?? "claude-opus-4-7";
    this.#defaultMaxTokens = options.defaultMaxTokens ?? 8192;
    this.#logger = options.logger;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const fn = this.#logger?.fn?.("anthropic.generate", {
      model: request.model ?? this.#defaultModel,
      messageCount: request.messages.length,
      toolsCount: request.tools?.length ?? 0,
    });
    const body = this.#toSdkRequest(request);
    try {
      const response = await this.#sdk.messages.create(body, {
        signal: request.signal,
      });
      const out = this.#fromSdkResponse(response);
      fn?.exit({ stopReason: out.stopReason, contentBlocks: out.content.length, usage: out.usage });
      return out;
    } catch (e) {
      fn?.branch("error");
      this.#logger?.error("llm.error", e as Error, { provider: "anthropic" });
      throw e;
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const body = this.#toSdkRequest(request);
    const sdkStream = this.#sdk.messages.stream(body, {
      signal: request.signal,
    });

    let model = body.model;
    let id = "";
    const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const event of sdkStream) {
      const chunk = this.#fromSdkStreamEvent(event);
      if (chunk) {
        if (chunk.type === "start") {
          id = chunk.id;
          model = chunk.model;
        }
        yield chunk;
      }

      if (event.type === "message_start") {
        usage.inputTokens = event.message.usage.input_tokens ?? 0;
        const cacheRead = event.message.usage.cache_read_input_tokens;
        if (cacheRead != null) usage.cacheReadTokens = cacheRead;
        const cacheWrite = event.message.usage.cache_creation_input_tokens;
        if (cacheWrite != null) usage.cacheWriteTokens = cacheWrite;
      }
      if (event.type === "message_delta") {
        usage.outputTokens = event.usage.output_tokens ?? 0;
        const mapped = mapSdkStopReason(event.delta.stop_reason);
        if (mapped) stopReason = mapped;
      }
    }

    yield { type: "end", stopReason, usage };
    void id;
    void model;
  }

  // ─── SDK ↔ naia-agent/types conversion ──────────────────────────────────

  #toSdkRequest(request: LLMRequest): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const body: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: request.model ?? this.#defaultModel,
      max_tokens: request.maxTokens ?? this.#defaultMaxTokens,
      messages: request.messages.map(toSdkMessage),
    };
    if (request.system !== undefined) {
      body.system =
        typeof request.system === "string"
          ? request.system
          : request.system.map(toSdkBlock) as Anthropic.Messages.TextBlockParam[];
    }
    if (request.tools !== undefined) {
      body.tools = request.tools.map(toSdkTool);
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.stop !== undefined) body.stop_sequences = request.stop;
    return body;
  }

  #fromSdkResponse(response: Anthropic.Messages.Message): LLMResponse {
    const usage: LLMUsage = {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
    };
    if (response.usage.cache_read_input_tokens != null) {
      usage.cacheReadTokens = response.usage.cache_read_input_tokens;
    }
    if (response.usage.cache_creation_input_tokens != null) {
      usage.cacheWriteTokens = response.usage.cache_creation_input_tokens;
    }
    return {
      id: response.id,
      model: response.model,
      content: mapSdkBlocks(response.content),
      stopReason: mapSdkStopReason(response.stop_reason) ?? "end_turn",
      usage,
    };
  }

  #fromSdkStreamEvent(event: Anthropic.Messages.RawMessageStreamEvent): LLMStreamChunk | undefined {
    switch (event.type) {
      case "message_start":
        return { type: "start", id: event.message.id, model: event.message.model };
      case "content_block_start": {
        const block = fromSdkBlock(event.content_block);
        if (!block) return undefined;
        return { type: "content_block_start", index: event.index, block };
      }
      case "content_block_delta": {
        const delta = fromSdkDelta(event.delta);
        if (!delta) return undefined;
        return { type: "content_block_delta", index: event.index, delta };
      }
      case "content_block_stop":
        return { type: "content_block_stop", index: event.index };
      default:
        return undefined;
    }
  }
}

// ─── Conversion helpers ──────────────────────────────────────────────────────

function toSdkMessage(msg: LLMMessage): Anthropic.Messages.MessageParam {
  if (msg.role === "tool") {
    // Anthropic convention: tool outputs are wrapped as a `user` message
    // with a `tool_result` block referencing `toolCallId`. If the caller
    // already provided a `tool_result` block array, pass through; otherwise
    // wrap the string content.
    if (typeof msg.content === "string") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content,
          },
        ],
      };
    }
    return {
      role: "user",
      content: msg.content.map(toSdkBlock) as Anthropic.Messages.ContentBlockParam[],
    };
  }

  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }
  return {
    role: msg.role,
    content: msg.content.map(toSdkBlock) as Anthropic.Messages.ContentBlockParam[],
  };
}

function toSdkBlock(block: LLMContentBlock): Anthropic.Messages.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature ?? "",
      };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content,
        ...(block.isError !== undefined && { is_error: block.isError }),
      };
    case "image":
      return {
        type: "image",
        source:
          block.source.type === "base64"
            ? ({
                type: "base64",
                media_type: block.source.mediaType,
                data: block.source.data,
              } as Anthropic.Messages.ImageBlockParam["source"])
            : ({ type: "url", url: block.source.data } as Anthropic.Messages.ImageBlockParam["source"]),
      };
  }
}

/**
 * Convert a single SDK block to a known LLMContentBlock variant, or
 * `undefined` if the block type has no mapping. Callers filter undefined
 * at the adapter boundary per LLMContentBlock contract ("drop unknown").
 */
function fromSdkBlock(block: Anthropic.Messages.ContentBlock): LLMContentBlock | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    default:
      return undefined;
  }
}

function mapSdkBlocks(blocks: readonly Anthropic.Messages.ContentBlock[]): LLMContentBlock[] {
  const out: LLMContentBlock[] = [];
  for (const b of blocks) {
    const mapped = fromSdkBlock(b);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

function fromSdkDelta(delta: Anthropic.Messages.RawContentBlockDeltaEvent["delta"]): LLMContentDelta | undefined {
  switch (delta.type) {
    case "text_delta":
      return { type: "text_delta", text: delta.text };
    case "thinking_delta":
      return { type: "thinking_delta", thinking: delta.thinking };
    case "input_json_delta":
      return { type: "input_json_delta", partialJson: delta.partial_json };
    default:
      return undefined;
  }
}

function toSdkTool(tool: ToolDefinition): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    input_schema: tool.inputSchema as Anthropic.Messages.Tool["input_schema"],
  };
}

function mapSdkStopReason(
  reason: Anthropic.Messages.Message["stop_reason"] | null | undefined,
): StopReason | undefined {
  if (!reason) return undefined;
  // SDK v0.39 supports end_turn/max_tokens/stop_sequence/tool_use.
  // pause_turn / refusal are in StopReason union for forward compat with
  // newer SDKs that add them; they route through the string cast below.
  const known: readonly StopReason[] = [
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
  ];
  return known.includes(reason as StopReason) ? (reason as StopReason) : undefined;
}
