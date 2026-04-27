/**
 * LabProxyClient — LLMClient implementation over Naia Lab Proxy
 * (any-llm Gateway on GCP).
 *
 * R4 Phase 4.1 Day 4.3.4 — Strangler Fig horizontal expansion (Lab-Proxy family).
 *
 * Auth: `X-AnyLLM-Key: Bearer <naiaKey>` header. HTTPS-only (rejects http://
 * gateway URLs to prevent credential leak in transit).
 *
 * Wire format: OpenAI-compat /v1/chat/completions (SSE streaming).
 *   Model name prefixing (toGatewayModel):
 *     - gemini*  → vertexai:<model>  (Gateway uses Vertex AI service account)
 *     - grok*    → xai:<model>
 *     - claude*  → anthropic:<model>
 *     - others   → passthrough
 *
 * Errors:
 *   - HTTPS check fail → throw Error
 *   - HTTP non-2xx → throw with status + truncated body
 *   - 0-byte SSE body → throw "empty SSE stream" (Gateway streaming bug:
 *     silent backend error returns 200 with empty body)
 */

import { randomUUID } from "node:crypto";
import type {
  LLMClient,
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMUsage,
  StopReason,
  ToolDefinition,
} from "@nextain/agent-types";

export interface LabProxyClientOptions {
  /** Naia Lab API key — sent as X-AnyLLM-Key Bearer token. */
  naiaKey: string;
  /** Gateway base URL (must be https://). */
  gatewayUrl: string;
  /** Default model. */
  defaultModel?: string;
}

const DEFAULT_PROD_GATEWAY_URL =
  "https://naia-gateway-181404717065.asia-northeast3.run.app";

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIMessage {
  role: string;
  content?: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

export class LabProxyClient implements LLMClient {
  readonly #naiaKey: string;
  readonly #gatewayUrl: string;
  readonly #defaultModel: string;

  constructor(opts: LabProxyClientOptions) {
    if (!opts.gatewayUrl.startsWith("https://")) {
      throw new Error(
        `LabProxyClient: rejecting non-HTTPS gateway URL "${opts.gatewayUrl}" — naiaKey must only be sent over HTTPS.`,
      );
    }
    this.#naiaKey = opts.naiaKey;
    this.#gatewayUrl = opts.gatewayUrl.replace(/\/+$/, "");
    this.#defaultModel = opts.defaultModel ?? "claude-opus-4-7";
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    // Single-shot via stream() collection.
    const id = randomUUID();
    const content: LLMContentBlock[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let textBuf = "";

    for await (const chunk of this.stream(request)) {
      if (chunk.type === "content_block_delta") {
        if (chunk.delta.type === "text_delta") textBuf += chunk.delta.text;
      } else if (chunk.type === "content_block_start" && chunk.block.type === "tool_use") {
        content.push(chunk.block);
      } else if (chunk.type === "end") {
        stopReason = chunk.stopReason;
        usage = chunk.usage;
      }
    }
    if (textBuf) content.unshift({ type: "text", text: textBuf });

    return {
      id,
      model: request.model ?? this.#defaultModel,
      content,
      stopReason,
      usage,
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const id = randomUUID();
    const model = request.model ?? this.#defaultModel;
    yield { type: "start", id, model };

    const body: Record<string, unknown> = {
      model: toGatewayModel(model),
      messages: messagesToOpenAI(request),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(toolToOpenAI);
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const res = await fetch(`${this.#gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AnyLLM-Key": `Bearer ${this.#naiaKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });

    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Lab proxy error ${res.status}: ${errText}`);
    }
    if (!res.body) {
      throw new Error("Lab proxy: no response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytesReceived = 0;
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let blockIndex = 0;
    let textBlockOpen = false;
    let textBlockIndex = 0;

    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesReceived += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          // Break on [DONE] — Gateway may keep HTTP connection open after.
          if (data === "[DONE]") break outer;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const choices = parsed["choices"] as
            | Array<{ delta?: Record<string, unknown> }>
            | undefined;
          const delta = choices?.[0]?.delta;

          // Text content
          if (delta && typeof delta["content"] === "string") {
            const text = delta["content"] as string;
            if (!textBlockOpen) {
              textBlockIndex = blockIndex++;
              textBlockOpen = true;
              yield {
                type: "content_block_start",
                index: textBlockIndex,
                block: { type: "text", text: "" },
              };
            }
            yield {
              type: "content_block_delta",
              index: textBlockIndex,
              delta: { type: "text_delta", text },
            };
          }

          // Tool calls — accumulate
          const toolCalls = delta?.["tool_calls"] as
            | Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>
            | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const existing = pendingToolCalls.get(tc.index);
              if (!existing) {
                pendingToolCalls.set(tc.index, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  args: tc.function?.arguments ?? "",
                });
              } else {
                if (tc.id && !existing.id) existing.id = tc.id;
                if (tc.function?.name && !existing.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }

          // Usage
          const u = parsed["usage"] as
            | { prompt_tokens?: number; completion_tokens?: number }
            | undefined;
          if (u) {
            if (u.prompt_tokens !== undefined) usage.inputTokens = u.prompt_tokens;
            if (u.completion_tokens !== undefined) usage.outputTokens = u.completion_tokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Close text block if opened.
    if (textBlockOpen) {
      yield { type: "content_block_stop", index: textBlockIndex };
    }

    // Emit accumulated tool_use blocks.
    for (const tc of pendingToolCalls.values()) {
      if (!tc.id || !tc.name) continue;
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(tc.args || "{}");
      } catch {
        parsedArgs = { _raw: tc.args };
      }
      const idx = blockIndex++;
      yield {
        type: "content_block_start",
        index: idx,
        block: { type: "tool_use", id: tc.id, name: tc.name, input: parsedArgs },
      };
      yield { type: "content_block_stop", index: idx };
    }

    // Gateway streaming bug: 200 OK with 0-byte body = silent backend error.
    if (bytesReceived === 0) {
      throw new Error(
        `Lab proxy: empty SSE stream for model "${model}" — gateway may lack credentials for this provider.`,
      );
    }

    yield { type: "end", stopReason: "end_turn", usage };
  }
}

/** Map local model name to gateway provider:model format. */
export function toGatewayModel(model: string): string {
  // Live API models are WebSocket-only — fall back to text equivalent for SSE.
  if (model === "gemini-2.5-flash-live") return "vertexai:gemini-2.5-flash";
  if (model === "gemini-3.1-flash-live-preview")
    return "vertexai:gemini-3-flash-preview";
  if (model.startsWith("gemini")) return `vertexai:${model}`;
  if (model.startsWith("grok")) return `xai:${model}`;
  if (model.startsWith("claude")) return `anthropic:${model}`;
  return model;
}

export const LAB_PROXY_DEFAULT_GATEWAY_URL = DEFAULT_PROD_GATEWAY_URL;

function toolToOpenAI(t: ToolDefinition) {
  const fn: { name: string; description?: string; parameters: Record<string, unknown> } = {
    name: t.name,
    parameters: t.inputSchema,
  };
  if (t.description) fn.description = t.description;
  return { type: "function" as const, function: fn };
}

function messagesToOpenAI(request: LLMRequest): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (request.system) {
    const sys =
      typeof request.system === "string"
        ? request.system
        : request.system
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
    out.push({ role: "system", content: sys });
  }
  for (const m of request.messages) {
    out.push(...convertMessage(m));
  }
  return out;
}

function convertMessage(m: LLMMessage): OAIMessage[] {
  if (typeof m.content === "string") {
    return [{ role: m.role, content: m.content }];
  }
  if (m.role === "assistant") {
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    const toolCalls: OAIToolCall[] = m.content
      .filter((b) => b.type === "tool_use")
      .map((b) =>
        b.type === "tool_use"
          ? {
              id: b.id,
              type: "function" as const,
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            }
          : null,
      )
      .filter((x): x is OAIToolCall => x !== null);
    const msg: OAIMessage = { role: "assistant", content: text || null };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    return [msg];
  }
  // user / tool
  const out: OAIMessage[] = [];
  let textParts: string[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result") {
      if (textParts.length > 0) {
        out.push({ role: m.role, content: textParts.join("\n") });
        textParts = [];
      }
      out.push({
        role: "tool",
        tool_call_id: b.toolCallId,
        content: b.content,
      });
    } else if (b.type === "text") {
      textParts.push(b.text);
    }
  }
  if (textParts.length > 0) out.push({ role: m.role, content: textParts.join("\n") });
  return out.length > 0 ? out : [{ role: m.role, content: "" }];
}
