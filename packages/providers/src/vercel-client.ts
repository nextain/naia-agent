/**
 * VercelClient — LLMClient implementation that wraps any Vercel AI SDK
 * `LanguageModelV2` instance (provider-utils v2 spec). One adapter unlocks
 * 50+ providers (Anthropic / OpenAI / Google / Vertex / OpenAI-compat for
 * vLLM/LM Studio / zhipu / community CLI providers / etc.) via the host
 * picking the appropriate `@ai-sdk/<provider>` factory.
 *
 * Usage (host wires the model factory; naia-agent never imports providers):
 *
 *   import { createAnthropic } from "@ai-sdk/anthropic";
 *   import { VercelClient } from "@nextain/agent-providers/vercel";
 *
 *   const anthropic = createAnthropic({ apiKey });
 *   const client = new VercelClient(anthropic("claude-opus-4-7"), {
 *     defaultMaxTokens: 8192,
 *   });
 *
 * `ai` and `@ai-sdk/<provider>` packages are optional peerDependencies; the
 * host installs and injects the model. naia-agent's runtime only knows
 * `LLMClient`.
 *
 * Design (adapter boundary):
 *   - `LLMClient` SSE shape mirrors Anthropic's events (start →
 *     content_block_start → content_block_delta* → content_block_stop →
 *     usage → end). Vercel V2 emits text-start/delta/end (and equivalents
 *     for reasoning + tool-input) keyed by string `id`; we map to numeric
 *     `index` as Anthropic does, preserving start/stop pairing per id.
 *   - V2 `tool-call` events (resolved/aggregate) are dropped because the
 *     same payload is fully covered by tool-input-start/delta/end, which
 *     emit Anthropic-style input_json_delta in our SSE shape. Emitting
 *     both would duplicate the block to downstream consumers.
 *   - Per LLMContentBlock policy ("drop unknown at adapter boundary"),
 *     V2 file/source/raw/response-metadata/stream-start parts that don't
 *     map to a known LLMContentBlock variant are dropped silently.
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import type {
  LLMClient,
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMUsage,
  Logger,
  StopReason,
  ToolDefinition,
} from "@nextain/agent-types";

export interface VercelClientOptions {
  /** Default max output tokens when LLMRequest.maxTokens is unset. */
  defaultMaxTokens?: number;
  /** Optional logger; emits enter/branch/exit traces if Logger.fn() exists. */
  logger?: Logger;
}

export class VercelClient implements LLMClient {
  readonly #model: LanguageModelV2;
  readonly #defaultMaxTokens: number;
  readonly #logger: Logger | undefined;

  constructor(model: LanguageModelV2, options: VercelClientOptions = {}) {
    if (model.specificationVersion !== "v2") {
      throw new Error(
        `VercelClient: unsupported LanguageModel spec "${(model as { specificationVersion: string }).specificationVersion}" — expected "v2"`,
      );
    }
    this.#model = model;
    this.#defaultMaxTokens = options.defaultMaxTokens ?? 8192;
    this.#logger = options.logger;
  }

  /** Provider id (e.g. "anthropic.messages"). Useful for telemetry. */
  get provider(): string {
    return this.#model.provider;
  }

  /** Model id bound at construction (e.g. "claude-opus-4-7"). */
  get modelId(): string {
    return this.#model.modelId;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const fn = this.#logger?.fn?.("vercel.generate", {
      provider: this.#model.provider,
      modelId: this.#model.modelId,
      messageCount: request.messages.length,
      toolsCount: request.tools?.length ?? 0,
    });
    const callOpts = this.#toCallOptions(request);
    try {
      const result = await this.#model.doGenerate(callOpts);
      const out: LLMResponse = {
        // V2 doGenerate doesn't return a message id at the response root;
        // synthesize via response-metadata if available, else random.
        id: result.response?.id ?? `vercel-${randomId()}`,
        model: result.response?.modelId ?? this.#model.modelId,
        content: fromV2Content(result.content),
        stopReason: fromV2FinishReason(result.finishReason),
        usage: fromV2Usage(result.usage),
      };
      fn?.exit({
        stopReason: out.stopReason,
        contentBlocks: out.content.length,
        usage: out.usage,
      });
      return out;
    } catch (e) {
      fn?.branch("error");
      this.#logger?.error?.("llm.error", e as Error, {
        provider: this.#model.provider,
      });
      throw e;
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const callOpts = this.#toCallOptions(request);
    const result = await this.#model.doStream(callOpts);

    // Synthesize a start chunk early. V2 may emit response-metadata later
    // with the real provider-assigned id; we don't retroactively patch
    // because downstream consumers have already received the start chunk.
    let messageId = `vercel-${randomId()}`;
    let model = this.#model.modelId;
    let started = false;

    // Map V2 string ids → numeric block index (Anthropic-style SSE).
    const idToIndex = new Map<string, number>();
    let nextIndex = 0;
    const indexFor = (id: string): number => {
      const existing = idToIndex.get(id);
      if (existing !== undefined) return existing;
      const idx = nextIndex++;
      idToIndex.set(id, idx);
      return idx;
    };

    let stopReason: StopReason = "end_turn";
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    const reader = result.stream.getReader();
    try {
      while (true) {
        const { done, value: part } = await reader.read();
        if (done) break;

        // Lazy emit start: prefer real response-metadata id/model when
        // available before any content has been sent.
        if (!started && part.type === "response-metadata") {
          if (part.id) messageId = part.id;
          if (part.modelId) model = part.modelId;
          // fall through to allow `started` flip below
        }

        if (!started && shouldEmitStart(part)) {
          started = true;
          yield { type: "start", id: messageId, model };
        }

        const chunk = toLLMStreamChunk(part, indexFor);
        if (chunk !== undefined) yield chunk;

        if (part.type === "finish") {
          stopReason = fromV2FinishReason(part.finishReason);
          usage = fromV2Usage(part.usage);
        } else if (part.type === "error") {
          throw part.error instanceof Error
            ? part.error
            : new Error(`VercelClient stream error: ${stringifyError(part.error)}`);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Always close with an end chunk, even if the upstream omitted finish.
    yield { type: "end", stopReason, usage };
  }

  // ─── LLMRequest → V2 call options ──────────────────────────────────────

  #toCallOptions(request: LLMRequest): LanguageModelV2CallOptions {
    const opts: LanguageModelV2CallOptions = {
      prompt: toV2Prompt(request),
      maxOutputTokens: request.maxTokens ?? this.#defaultMaxTokens,
    };
    if (request.temperature !== undefined) opts.temperature = request.temperature;
    if (request.stop !== undefined) opts.stopSequences = request.stop;
    if (request.signal !== undefined) opts.abortSignal = request.signal;
    if (request.tools !== undefined && request.tools.length > 0) {
      opts.tools = request.tools.map(toV2Tool);
    }
    return opts;
  }
}

// ─── Conversion helpers (pure, exported for testing) ────────────────────

export function toV2Prompt(request: LLMRequest): LanguageModelV2Prompt {
  const out: LanguageModelV2Prompt = [];
  if (request.system !== undefined) {
    const text =
      typeof request.system === "string"
        ? request.system
        : request.system
            .map((b) => (b.type === "text" ? b.text : ""))
            .filter((s) => s !== "")
            .join("\n");
    if (text !== "") {
      out.push({ role: "system", content: text });
    }
  }
  for (const msg of request.messages) {
    out.push(toV2Message(msg));
  }
  return out;
}

function toV2Message(msg: LLMMessage): LanguageModelV2Message {
  if (msg.role === "tool") {
    // Tool messages: each block must be a tool-result. If `content` is a
    // string, wrap as a single tool-result with text output and the
    // message-level toolCallId. toolName is required by V2 but not always
    // tracked in our LLMMessage shape; "" is accepted by all known
    // providers that match on toolCallId (Anthropic / OpenAI-compat).
    if (typeof msg.content === "string") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId ?? "",
            toolName: "",
            output: { type: "text", value: msg.content },
          },
        ],
      };
    }
    const parts: LanguageModelV2Message & { role: "tool" } = {
      role: "tool",
      content: [],
    };
    for (const b of msg.content) {
      if (b.type === "tool_result") {
        parts.content.push({
          type: "tool-result",
          toolCallId: b.toolCallId,
          toolName: "",
          output: b.isError
            ? { type: "error-text", value: b.content }
            : { type: "text", value: b.content },
        });
      }
      // Other block types are invalid in tool role per V2; drop.
    }
    return parts;
  }

  if (typeof msg.content === "string") {
    if (msg.role === "user") {
      return {
        role: "user",
        content: [{ type: "text", text: msg.content }],
      };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: msg.content }],
    };
  }

  if (msg.role === "user") {
    return {
      role: "user",
      content: msg.content
        .map(toV2UserPart)
        .filter((p): p is NonNullable<typeof p> => p !== undefined),
    };
  }
  return {
    role: "assistant",
    content: msg.content
      .map(toV2AssistantPart)
      .filter((p): p is NonNullable<typeof p> => p !== undefined),
  };
}

function toV2UserPart(
  block: LLMContentBlock,
):
  | { type: "text"; text: string }
  | { type: "file"; data: string | URL; mediaType: string }
  | undefined {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    if (block.source.type === "url") {
      return {
        type: "file",
        data: new URL(block.source.data),
        mediaType: block.source.mediaType,
      };
    }
    return {
      type: "file",
      data: block.source.data, // base64 string
      mediaType: block.source.mediaType,
    };
  }
  // tool_use / tool_result / thinking / redacted_thinking are invalid in
  // user role per V2 prompt schema; drop at adapter boundary.
  return undefined;
}

function toV2AssistantPart(
  block: LLMContentBlock,
):
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "reasoning", text: block.thinking };
    case "redacted_thinking":
      // V2 has no native redacted-reasoning shape; preserve as opaque
      // reasoning text marker so context isn't dropped silently.
      return { type: "reasoning", text: `[redacted: ${block.data.length}b]` };
    case "tool_use":
      return {
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      };
    default:
      return undefined;
  }
}

function toV2Tool(tool: ToolDefinition): LanguageModelV2FunctionTool {
  const out: LanguageModelV2FunctionTool = {
    type: "function",
    name: tool.name,
    inputSchema: tool.inputSchema,
  };
  if (tool.description !== undefined) out.description = tool.description;
  return out;
}

// ─── V2 result/stream → LLMResponse / LLMStreamChunk ───────────────────

export function fromV2Content(
  content: readonly LanguageModelV2Content[],
): LLMContentBlock[] {
  const out: LLMContentBlock[] = [];
  for (const c of content) {
    switch (c.type) {
      case "text":
        out.push({ type: "text", text: c.text });
        break;
      case "reasoning":
        out.push({ type: "thinking", thinking: c.text });
        break;
      case "tool-call": {
        // V2 tool-call.input is a stringified JSON; parse to unknown.
        out.push({
          type: "tool_use",
          id: c.toolCallId,
          name: c.toolName,
          input: safeParseJson(c.input),
        });
        break;
      }
      case "file": {
        if (typeof c.mediaType === "string" && c.mediaType.startsWith("image/")) {
          const data = c.data;
          if (typeof data === "string") {
            out.push({
              type: "image",
              source: { type: "base64", mediaType: c.mediaType, data },
            });
          }
          // Uint8Array/URL image data: not yet wired through LLMImageSource;
          // drop at adapter boundary per "unknown variants drop" policy.
        }
        break;
      }
      // source / tool-result are not represented in our content blocks.
      default:
        break;
    }
  }
  return out;
}

export function fromV2FinishReason(
  reason: LanguageModelV2FinishReason | undefined,
): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "refusal";
    case "tool-calls":
      return "tool_use";
    case "error":
    case "other":
    case "unknown":
    case undefined:
      return "end_turn";
  }
}

export function fromV2Usage(usage: LanguageModelV2Usage): LLMUsage {
  const out: LLMUsage = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  if (usage.cachedInputTokens != null) {
    out.cacheReadTokens = usage.cachedInputTokens;
  }
  return out;
}

// ─── Stream-part conversion ─────────────────────────────────────────────

function shouldEmitStart(part: LanguageModelV2StreamPart): boolean {
  // Defer the synthetic start until we actually have content to emit.
  // stream-start (warnings) and response-metadata are pre-content; we
  // delay so any id/modelId from response-metadata is included.
  switch (part.type) {
    case "stream-start":
    case "response-metadata":
      return false;
    default:
      return true;
  }
}

function toLLMStreamChunk(
  part: LanguageModelV2StreamPart,
  indexFor: (id: string) => number,
): LLMStreamChunk | undefined {
  switch (part.type) {
    case "text-start":
      return {
        type: "content_block_start",
        index: indexFor(part.id),
        block: { type: "text", text: "" },
      };
    case "text-delta":
      return {
        type: "content_block_delta",
        index: indexFor(part.id),
        delta: { type: "text_delta", text: part.delta },
      };
    case "text-end":
      return { type: "content_block_stop", index: indexFor(part.id) };

    case "reasoning-start":
      return {
        type: "content_block_start",
        index: indexFor(part.id),
        block: { type: "thinking", thinking: "" },
      };
    case "reasoning-delta":
      return {
        type: "content_block_delta",
        index: indexFor(part.id),
        delta: { type: "thinking_delta", thinking: part.delta },
      };
    case "reasoning-end":
      return { type: "content_block_stop", index: indexFor(part.id) };

    case "tool-input-start":
      return {
        type: "content_block_start",
        index: indexFor(part.id),
        block: { type: "tool_use", id: part.id, name: part.toolName, input: {} },
      };
    case "tool-input-delta":
      return {
        type: "content_block_delta",
        index: indexFor(part.id),
        delta: { type: "input_json_delta", partialJson: part.delta },
      };
    case "tool-input-end":
      return { type: "content_block_stop", index: indexFor(part.id) };

    case "finish":
      return {
        type: "usage",
        usage: fromV2Usage(part.usage),
      };

    // Drop: aggregate tool-call (covered by tool-input-* path), stream-start,
    // response-metadata, file, source, raw, error (handled in caller).
    default:
      return undefined;
  }
}

// ─── small utilities ────────────────────────────────────────────────────

function safeParseJson(s: string): unknown {
  if (typeof s !== "string" || s === "") return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function stringifyError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function randomId(): string {
  // 12-char base36 token; non-cryptographic — telemetry id only.
  return Math.random().toString(36).slice(2, 14);
}
