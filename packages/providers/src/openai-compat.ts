// Slice 1c (extension) — OpenAI-compat LLM client.
//
// Minimal fetch-based wrapper. No SDK dependency (matrix B21 compliance —
// avoids 50-provider direct deps). Supports any endpoint that speaks
// OpenAI Chat Completions API: zai/Zhipu GLM (open.bigmodel.cn),
// vLLM/Ollama (OpenAI-compat mode), OpenRouter, Together, Groq, etc.
//
// Required:
//   - apiKey + baseUrl + model
// Maps:
//   - LLMRequest.messages → OpenAI messages (system extracted from request.system)
//   - response.choices[0].message.content → LLMContentBlock[] (text only)
//   - stream: minimal (yields full response as one chunk for simplicity)

import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
  StopReason,
} from "@nextain/agent-types";

export interface OpenAICompatClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  defaultMaxTokens?: number;
}

interface OpenAIChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: {
    message: { role: string; content: string };
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
    // Simple non-streaming impl: do generate(), emit as one block.
    // True SSE streaming is a Slice 5 enhancement.
    if (request.signal?.aborted) return;
    const response = await this.generate(request);
    const id = response.id;
    yield { type: "start", id, model: response.model };
    for (let i = 0; i < response.content.length; i++) {
      const block = response.content[i];
      if (!block || block.type !== "text") continue;
      yield { type: "content_block_start", index: i, block };
      yield {
        type: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text: block.text },
      };
      yield { type: "content_block_stop", index: i };
    }
    yield {
      type: "end",
      stopReason: response.stopReason,
      usage: response.usage,
    };
  }

  #toOpenAIRequest(request: LLMRequest, stream: boolean): OpenAIChatRequest {
    const messages: { role: string; content: string }[] = [];
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
      messages.push({ role: m.role, content: this.#flattenContent(m) });
    }
    return {
      model: request.model ?? this.#model,
      messages,
      max_tokens: request.maxTokens ?? this.#defaultMaxTokens,
      ...(stream ? { stream: true } : {}),
    };
  }

  #flattenContent(m: LLMMessage): string {
    const c = m.content;
    if (typeof c === "string") return c;
    return c
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  }

  #fromOpenAIResponse(r: OpenAIChatResponse): LLMResponse {
    const text = r.choices[0]?.message?.content ?? "";
    const finish = r.choices[0]?.finish_reason ?? "stop";
    return {
      id: r.id,
      model: r.model,
      content: [{ type: "text", text }],
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
