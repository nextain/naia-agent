// Slice 1c (extension) + Slice 2.5 — OpenAI-compat LLM client.
//
// Minimal fetch-based wrapper. No SDK dependency (matrix B21 compliance —
// avoids 50-provider direct deps). Supports any endpoint that speaks
// OpenAI Chat Completions API: zai/Zhipu GLM (open.bigmodel.cn),
// vLLM/Ollama (OpenAI-compat mode), OpenRouter, Together, Groq, etc.
//
// Slice 2.5 adds tool calling translation:
//   - LLMRequest.tools → OpenAI tools[] (function-calling format)
//   - response.choices[0].message.tool_calls → LLMContentBlock[] tool_use
//   - LLMMessage tool_use/tool_result blocks → OpenAI assistant.tool_calls / tool message

import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
  LLMContentBlock,
  StopReason,
  ToolDefinition,
} from "@nextain/agent-types";

export interface OpenAICompatClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  defaultMaxTokens?: number;
}

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

interface OAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OAIMessage[];
  tools?: OAITool[];
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: {
    message: OAIMessage;
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAICompatClient implements LLMClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #defaultMaxTokens: number;

  constructor(opts: OpenAICompatClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#model = opts.model;
    this.#defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const body = this.#toOpenAIRequest(request, false);
    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
    if (!res.ok) {
      throw new Error(
        `OpenAICompat ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as OpenAIChatResponse;
    return this.#fromOpenAIResponse(json);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    // Simple non-streaming impl: do generate(), emit as one block sequence.
    // True SSE streaming is a Slice 5 enhancement.
    if (request.signal?.aborted) return;
    const response = await this.generate(request);
    const id = response.id;
    yield { type: "start", id, model: response.model };
    for (let i = 0; i < response.content.length; i++) {
      const block = response.content[i];
      if (!block) continue;
      yield { type: "content_block_start", index: i, block };
      if (block.type === "text") {
        yield {
          type: "content_block_delta",
          index: i,
          delta: { type: "text_delta", text: block.text },
        };
      } else if (block.type === "tool_use") {
        yield {
          type: "content_block_delta",
          index: i,
          delta: { type: "input_json_delta", partialJson: JSON.stringify(block.input) },
        };
      }
      yield { type: "content_block_stop", index: i };
    }
    yield {
      type: "end",
      stopReason: response.stopReason,
      usage: response.usage,
    };
  }

  #toOpenAIRequest(request: LLMRequest, stream: boolean): OpenAIChatRequest {
    const messages: OAIMessage[] = [];
    if (request.system) {
      const sys =
        typeof request.system === "string"
          ? request.system
          : request.system
              .filter((b) => b.type === "text")
              .map((b) => (b.type === "text" ? b.text : ""))
              .join("\n");
      messages.push({ role: "system", content: sys });
    }
    for (const m of request.messages) {
      messages.push(...this.#convertMessageToOAI(m));
    }

    const tools = request.tools ? request.tools.map(toolToOAI) : undefined;

    const out: OpenAIChatRequest = {
      model: request.model ?? this.#model,
      messages,
      max_tokens: request.maxTokens ?? this.#defaultMaxTokens,
    };
    if (tools && tools.length > 0) out.tools = tools;
    if (stream) out.stream = true;
    return out;
  }

  /**
   * Convert one LLMMessage to OAI message(s). assistant w/ tool_use → tool_calls.
   * tool/user with tool_result → multiple OAI messages (one per tool result).
   */
  #convertMessageToOAI(m: LLMMessage): OAIMessage[] {
    const c = m.content;
    if (typeof c === "string") {
      return [{ role: m.role, content: c }];
    }

    if (m.role === "assistant") {
      const text = c
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      const toolCalls: OAIToolCall[] = c
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

    // user / tool / system: tool_result blocks → role:"tool" messages.
    const out: OAIMessage[] = [];
    let textParts: string[] = [];
    for (const b of c) {
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

  #fromOpenAIResponse(r: OpenAIChatResponse): LLMResponse {
    const msg = r.choices[0]?.message;
    const finish = r.choices[0]?.finish_reason ?? "stop";
    const content: LLMContentBlock[] = [];

    if (msg?.content) {
      content.push({ type: "text", text: msg.content });
    }
    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsed = { _raw: tc.function.arguments };
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parsed,
        });
      }
    }

    // Ensure at least one block
    if (content.length === 0) content.push({ type: "text", text: "" });

    return {
      id: r.id,
      model: r.model,
      content,
      stopReason: this.#mapStopReason(finish),
      usage: {
        inputTokens: r.usage?.prompt_tokens ?? 0,
        outputTokens: r.usage?.completion_tokens ?? 0,
      },
    };
  }

  #mapStopReason(finish: string): StopReason {
    switch (finish) {
      case "stop":
      case "end_turn":
        return "end_turn";
      case "length":
        return "max_tokens";
      case "tool_calls":
      case "function_call":
        return "tool_use";
      default:
        return "end_turn";
    }
  }
}

function toolToOAI(t: ToolDefinition): OAITool {
  const fn: OAITool["function"] = {
    name: t.name,
    parameters: t.inputSchema,
  };
  if (t.description) fn.description = t.description;
  return { type: "function", function: fn };
}
