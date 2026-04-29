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
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
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

/**
 * VercelClient accepts both `LanguageModelV2` and `LanguageModelV3` because
 * the Vercel SDK ecosystem is mid-migration: `@ai-sdk/anthropic@2.x` still
 * targets V2, while `@ai-sdk/google@3.x` / `@ai-sdk/openai-compatible@2.x`
 * / community providers (`ai-sdk-provider-claude-code@3.x`,
 * `zhipu-ai-provider`) target V3. Differences are limited to:
 *   - `finishReason`: V2 plain string, V3 `{unified, raw}` object
 *   - `usage`:        V2 flat `{inputTokens, outputTokens, ...}`,
 *                     V3 nested `{inputTokens: {total, cacheRead, ...}, ...}`
 *   - Stream parts and content shapes are otherwise compatible.
 *
 * Both shapes are normalized at the adapter boundary; downstream
 * consumers see a stable LLMClient SSE shape regardless of provider spec.
 */
type LanguageModelV2OrV3 = LanguageModelV2 | LanguageModelV3;
type V2OrV3FinishReason = LanguageModelV2FinishReason | LanguageModelV3FinishReason;
type V2OrV3Usage = LanguageModelV2Usage | LanguageModelV3Usage;
type V2OrV3StreamPart = LanguageModelV2StreamPart | LanguageModelV3StreamPart;
type V2OrV3Content = LanguageModelV2Content | LanguageModelV3Content;

export class VercelClient implements LLMClient {
  readonly #model: LanguageModelV2OrV3;
  readonly #defaultMaxTokens: number;
  readonly #logger: Logger | undefined;

  constructor(model: LanguageModelV2OrV3, options: VercelClientOptions = {}) {
    const spec = (model as { specificationVersion?: string }).specificationVersion;
    if (spec !== "v2" && spec !== "v3") {
      throw new Error(
        `VercelClient: unsupported LanguageModel spec "${spec}" — expected "v2" or "v3"`,
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
    // V2/V3 call options are structurally compatible for the subset we use
    // (prompt / maxOutputTokens / temperature / stopSequences / abortSignal /
    // tools); `doGenerate` overload union does not narrow on assignment, so
    // we route through `unknown` and assert the structurally-shared shape.
    const callOpts = this.#toCallOptions(request);
    try {
      const result = await (this.#model.doGenerate as unknown as (o: typeof callOpts) => Promise<{
        content: readonly V2OrV3Content[];
        finishReason: V2OrV3FinishReason;
        usage: V2OrV3Usage;
        response?: { id?: string; modelId?: string };
      }>)(callOpts);
      const out: LLMResponse = {
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
    // Same V2/V3 union cast pattern as in generate(); see comment there.
    const result = await (this.#model.doStream as unknown as (o: typeof callOpts) => Promise<{
      stream: ReadableStream<V2OrV3StreamPart>;
    }>)(callOpts);

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

// ─── V2/V3 result → LLMResponse helpers ─────────────────────────────────

/**
 * Convert V2 or V3 content array to LLMContentBlock[]. Both spec versions
 * share the same content union (text / reasoning / tool-call / file /
 * source / tool-result), so a single switch handles both shapes — the
 * differences are confined to providerMetadata fields we don't consume.
 */
export function fromV2Content(
  content: readonly V2OrV3Content[],
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
        // V2/V3 tool-call.input is a stringified JSON; parse to unknown.
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
      // source / tool-result / tool-approval-request not represented.
      default:
        break;
    }
  }
  return out;
}

/**
 * Normalize V2 (string) and V3 (`{unified, raw}` object) finish reasons.
 * V2 emits `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error'
 * | 'other' | 'unknown'`. V3 wraps the same vocabulary (minus 'unknown')
 * inside `unified`. Either way the unified token vocabulary maps 1:1 to
 * our StopReason union.
 */
export function fromV2FinishReason(
  reason: V2OrV3FinishReason | undefined,
): StopReason {
  if (reason === undefined) return "end_turn";
  // V3: extract `.unified` field; V2: pass through string.
  const token =
    typeof reason === "string"
      ? reason
      : (reason as { unified?: string }).unified;
  switch (token) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "refusal";
    case "tool-calls":
      return "tool_use";
    default:
      // 'error' / 'other' / 'unknown' / unrecognized → end_turn fallback.
      return "end_turn";
  }
}

/**
 * Flatten V2 (already flat) and V3 (nested `inputTokens.{total,cacheRead}`)
 * usage shapes to LLMUsage.
 */
export function fromV2Usage(usage: V2OrV3Usage): LLMUsage {
  // V3 detection via nested `inputTokens` object shape.
  const inT = (usage as { inputTokens?: unknown }).inputTokens;
  if (inT !== null && typeof inT === "object") {
    // V3 nested shape.
    const v3 = usage as LanguageModelV3Usage;
    const out: LLMUsage = {
      inputTokens: v3.inputTokens.total ?? 0,
      outputTokens: v3.outputTokens.total ?? 0,
    };
    if (v3.inputTokens.cacheRead != null) {
      out.cacheReadTokens = v3.inputTokens.cacheRead;
    }
    if (v3.inputTokens.cacheWrite != null) {
      out.cacheWriteTokens = v3.inputTokens.cacheWrite;
    }
    return out;
  }
  // V2 flat shape.
  const v2 = usage as LanguageModelV2Usage;
  const out: LLMUsage = {
    inputTokens: v2.inputTokens ?? 0,
    outputTokens: v2.outputTokens ?? 0,
  };
  if (v2.cachedInputTokens != null) {
    out.cacheReadTokens = v2.cachedInputTokens;
  }
  return out;
}

// ─── Stream-part conversion ─────────────────────────────────────────────

function shouldEmitStart(part: V2OrV3StreamPart): boolean {
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
  part: V2OrV3StreamPart,
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
