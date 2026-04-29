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
type SpecVersion = "v2" | "v3";

export class VercelClient implements LLMClient {
  readonly #model: LanguageModelV2OrV3;
  readonly #spec: SpecVersion;
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
    // Pin spec at construction (5.x.6 cross-review P0-2). Helpers receive
    // this discriminant explicitly instead of structural sniffing on every
    // chunk — prevents silent token miscount if a wrapper proxies a V3
    // shape under "v2" specificationVersion.
    this.#spec = spec;
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
        content: fromVercelContent(result.content),
        stopReason: fromVercelFinishReason(result.finishReason, this.#spec),
        usage: fromVercelUsage(result.usage, this.#spec),
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

        // 5.x.6 cross-review P0-5: tool-call aggregate fallback. Some
        // providers (Bedrock, certain openai-compatible servers) emit a
        // single `tool-call` part without preceding tool-input-* deltas.
        // If the id was never seen via tool-input-start, synthesize the
        // full content_block_* trio so the tool call isn't silently lost.
        if (part.type === "tool-call" && !idToIndex.has(part.toolCallId)) {
          const idx = indexFor(part.toolCallId);
          yield {
            type: "content_block_start",
            index: idx,
            block: {
              type: "tool_use",
              id: part.toolCallId,
              name: part.toolName,
              input: {},
            },
          };
          yield {
            type: "content_block_delta",
            index: idx,
            delta: {
              type: "input_json_delta",
              partialJson: typeof part.input === "string" ? part.input : "",
            },
          };
          yield { type: "content_block_stop", index: idx };
        } else {
          const chunk = toLLMStreamChunk(part, indexFor);
          if (chunk !== undefined) yield chunk;
        }

        if (part.type === "finish") {
          stopReason = fromVercelFinishReason(part.finishReason, this.#spec);
          usage = fromVercelUsage(part.usage, this.#spec);
        } else if (part.type === "error") {
          throw part.error instanceof Error
            ? part.error
            : new Error(`VercelClient stream error: ${stringifyError(part.error)}`);
        }
      }
    } finally {
      // 5.x.6 cross-review P1-C: cancel() upstream so the provider's
      // ReadableStream releases HTTP/SSE connection on early consumer exit
      // (e.g. break out of `for await`). releaseLock alone leaks.
      try {
        await reader.cancel();
      } catch {
        // cancel() is idempotent / best-effort; some streams reject after
        // they've already finished. Ignore — releaseLock still runs below.
      }
      reader.releaseLock();
    }

    // Always close with an end chunk, even if the upstream omitted finish.
    // NOTE: this end chunk is NOT emitted on the throw path above (V2/V3
    // stream `error` part). Consumers that depend on always seeing `end`
    // must wrap their iteration in try/finally. See README "Contract".
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
    // tracked in our LLMMessage shape; "" is **only verified safe with
    // Anthropic** (matches on toolCallId) — Bedrock and some openai-
    // compatible servers may strict-validate toolName non-empty and
    // 400. Tracked as Tier B (D45-candidate) follow-up: thread toolName
    // through LLMMessage or maintain a per-session toolCallId→toolName map.
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
//
// 5.x.6 cross-review P1-1 (architect): renamed from `fromV2*` to
// `fromVercel*` since both V2 and V3 are handled. The `fromV2*` legacy
// aliases below are kept exported for backward compatibility within
// 5.x; remove in 5.x.7+.
// 5.x.6 cross-review P0-2 (architect): finishReason / usage helpers now
// take an explicit `spec: SpecVersion` discriminant instead of structural
// sniffing — pinned at construction by VercelClient.#spec.

/**
 * Convert V2 or V3 content array to LLMContentBlock[]. Both spec versions
 * share the same content union (text / reasoning / tool-call / file /
 * source / tool-result), so a single switch handles both shapes — the
 * differences are confined to providerMetadata fields we don't consume.
 */
export function fromVercelContent(
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
 *
 * `spec` is the discriminant pinned at VercelClient construction; passing
 * it explicitly avoids structural sniffing per chunk.
 */
export function fromVercelFinishReason(
  reason: V2OrV3FinishReason | undefined,
  spec: SpecVersion,
): StopReason {
  if (reason === undefined) return "end_turn";
  // V3: extract `.unified` field; V2: pass through string.
  // (Defensive: if the spec discriminant disagrees with the runtime
  // shape, prefer the runtime — a wrapper that lies about specVersion
  // shouldn't crash here.)
  const token =
    spec === "v3" || typeof reason !== "string"
      ? (reason as { unified?: string }).unified ??
        (typeof reason === "string" ? reason : undefined)
      : reason;
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
 * Flatten V2 (flat) and V3 (nested) usage shapes to LLMUsage.
 *
 * V2 spec: `{ inputTokens, outputTokens, totalTokens, cachedInputTokens? }`.
 * However `@ai-sdk/anthropic@2.x` does NOT populate `cachedInputTokens`
 * directly — it sets `inputTokenDetails.{cacheReadTokens, cacheWriteTokens}`.
 * We read both forms (V2 cross-review P0-4).
 *
 * V3 spec: `{ inputTokens: { total, cacheRead, cacheWrite }, outputTokens: { total, ... } }`.
 *
 * `spec` is the discriminant pinned at construction; we still defensively
 * accept the other shape if the wrapper lies about specVersion.
 */
export function fromVercelUsage(usage: V2OrV3Usage, spec: SpecVersion): LLMUsage {
  if (spec === "v3") {
    const v3 = usage as LanguageModelV3Usage;
    const out: LLMUsage = {
      inputTokens: v3.inputTokens?.total ?? 0,
      outputTokens: v3.outputTokens?.total ?? 0,
    };
    if (v3.inputTokens?.cacheRead != null) {
      out.cacheReadTokens = v3.inputTokens.cacheRead;
    }
    if (v3.inputTokens?.cacheWrite != null) {
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
  // V2 spec puts cache info in `cachedInputTokens`, but @ai-sdk/anthropic@2.x
  // populates `inputTokenDetails.{cacheReadTokens, cacheWriteTokens}` instead.
  // Read both forms (P0-4).
  if (v2.cachedInputTokens != null) {
    out.cacheReadTokens = v2.cachedInputTokens;
  }
  const details = (v2 as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }).inputTokenDetails;
  if (details) {
    if (details.cacheReadTokens != null && out.cacheReadTokens === undefined) {
      out.cacheReadTokens = details.cacheReadTokens;
    }
    if (details.cacheWriteTokens != null) {
      out.cacheWriteTokens = details.cacheWriteTokens;
    }
  }
  return out;
}

// Legacy aliases (5.x.6 cross-review P1-1). Remove in 5.x.7+.
/** @deprecated Use {@link fromVercelContent}. */
export const fromV2Content = fromVercelContent;
/** @deprecated Use {@link fromVercelFinishReason} with explicit spec. */
export function fromV2FinishReason(reason: V2OrV3FinishReason | undefined): StopReason {
  // Best-effort spec inference for legacy callers: V3 has object-typed
  // reason; V2 has string. This matches pre-cross-review behavior.
  return fromVercelFinishReason(reason, typeof reason === "object" && reason !== null ? "v3" : "v2");
}
/** @deprecated Use {@link fromVercelUsage} with explicit spec. */
export function fromV2Usage(usage: V2OrV3Usage): LLMUsage {
  // Legacy structural sniff for backward compat. New callers must pass spec.
  const inT = (usage as { inputTokens?: unknown }).inputTokens;
  return fromVercelUsage(usage, inT !== null && typeof inT === "object" ? "v3" : "v2");
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
