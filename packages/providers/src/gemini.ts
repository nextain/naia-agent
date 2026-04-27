/**
 * GeminiClient — LLMClient implementation over @google/genai SDK.
 *
 * R4 Phase 5 Day 7.1 — Gemini 3 thoughtSignature parity (full feature).
 *
 * Usage:
 *   import { GoogleGenAI } from "@google/genai";
 *   import { GeminiClient } from "@nextain/agent-providers/gemini";
 *
 *   const sdk = new GoogleGenAI({ apiKey });
 *   const client = new GeminiClient(sdk, { defaultModel: "gemini-2.5-flash" });
 *
 * `@google/genai` is a peerDependency — the host installs and injects.
 *
 * Why a dedicated client (vs. OpenAI-compat path):
 * - Gemini 3 returns `thoughtSignature` opaque token in `functionCall` parts
 * - Required to echo back in subsequent turns for thinking-aware tool calling
 * - OpenAI-compat endpoint (v1beta/openai) drops thoughtSignature → tool loop
 *   accuracy degradation in Gemini 3 thinking mode
 */

import { randomUUID } from "node:crypto";
import type { GoogleGenAI } from "@google/genai";
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

export interface GeminiClientOptions {
  defaultModel?: string;
  /**
   * Gemini 3 series recommends temperature 1.0 (default lower may cause
   * looping). Auto-detect via `gemini-3*` model prefix.
   */
  defaultTemperature?: number;
}

export class GeminiClient implements LLMClient {
  readonly #sdk: GoogleGenAI;
  readonly #defaultModel: string;
  readonly #explicitTemp: number | undefined;

  constructor(sdk: GoogleGenAI, options: GeminiClientOptions = {}) {
    this.#sdk = sdk;
    this.#defaultModel = options.defaultModel ?? "gemini-2.5-flash";
    this.#explicitTemp = options.defaultTemperature;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
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

    const isGemini3 = model.startsWith("gemini-3");
    const temperature = this.#explicitTemp ?? (isGemini3 ? 1.0 : 0.7);

    const contents = this.#convertMessages(request.messages);
    const systemInstruction = this.#systemString(request);
    const tools = request.tools ? this.#convertTools(request.tools) : undefined;

    const config: Record<string, unknown> = { temperature };
    if (systemInstruction) config["systemInstruction"] = systemInstruction;
    if (tools) {
      config["tools"] = tools;
      config["toolConfig"] = {
        // FunctionCallingConfigMode.AUTO — let model decide
        functionCallingConfig: { mode: "AUTO" },
      };
    }

    const response = await this.#sdk.models.generateContentStream({
      model,
      contents,
      config,
    });

    let textBlockOpen = false;
    let textBlockIndex = 0;
    let blockIndex = 0;
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const chunk of response) {
      if (request.signal?.aborted) break;

      const text = (chunk as { text?: string }).text;
      if (text) {
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

      // Tool calls (functionCall parts) — capture thoughtSignature.
      const candidates = (chunk as unknown as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> }).candidates;
      const parts = candidates?.[0]?.content?.parts;
      if (parts) {
        for (const part of parts) {
          const fc = part["functionCall"] as { id?: string; name?: string; args?: unknown } | undefined;
          if (fc) {
            const idx = blockIndex++;
            const toolBlock: LLMContentBlock = {
              type: "tool_use",
              id: fc.id || randomUUID(),
              name: fc.name || "unknown",
              input: fc.args ?? {},
            };
            // Day 7.1 — preserve thoughtSignature for Gemini 3 thinking parity.
            const sig = part["thoughtSignature"];
            if (typeof sig === "string") {
              (toolBlock as { thoughtSignature?: string }).thoughtSignature = sig;
            }
            yield {
              type: "content_block_start",
              index: idx,
              block: toolBlock,
            };
            yield { type: "content_block_stop", index: idx };
            stopReason = "tool_use";
          }
        }
      }

      const usageMetadata = (chunk as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
      if (usageMetadata) {
        if (usageMetadata.promptTokenCount !== undefined) {
          usage.inputTokens = usageMetadata.promptTokenCount;
        }
        if (usageMetadata.candidatesTokenCount !== undefined) {
          usage.outputTokens = usageMetadata.candidatesTokenCount;
        }
      }
    }

    if (textBlockOpen) {
      yield { type: "content_block_stop", index: textBlockIndex };
    }

    yield { type: "end", stopReason, usage };
  }

  #systemString(request: LLMRequest): string {
    if (!request.system) return "";
    if (typeof request.system === "string") return request.system;
    return request.system
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  }

  #convertMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
      if (typeof m.content === "string") {
        return {
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        };
      }
      // Block array — handle assistant tool_use vs user tool_result.
      const toolUseBlocks = m.content.filter((b) => b.type === "tool_use");
      if (m.role === "assistant" && toolUseBlocks.length > 0) {
        return {
          role: "model",
          parts: toolUseBlocks.map((b) => {
            if (b.type !== "tool_use") return null;
            const part: Record<string, unknown> = {
              functionCall: { id: b.id, name: b.name, args: b.input },
            };
            // Day 7.1 — echo thoughtSignature back to Gemini for thinking continuity.
            const sig = (b as { thoughtSignature?: string }).thoughtSignature;
            if (typeof sig === "string") {
              part["thoughtSignature"] = sig;
            }
            return part;
          }).filter((p): p is Record<string, unknown> => p !== null),
        };
      }
      const toolResultBlocks = m.content.filter((b) => b.type === "tool_result");
      if (toolResultBlocks.length > 0) {
        const parts: Array<Record<string, unknown>> = [];
        for (const b of toolResultBlocks) {
          if (b.type !== "tool_result") continue;
          parts.push({
            functionResponse: {
              id: b.toolCallId,
              name: b.toolCallId,  // Gemini requires name; caller can override
              response: { output: b.content },
            },
          });
        }
        return { role: "user", parts };
      }
      // Default — concatenate text parts.
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      };
    });
  }

  #convertTools(tools: ToolDefinition[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
    return [
      {
        functionDeclarations: tools.map((t) => {
          const decl: Record<string, unknown> = {
            name: t.name,
            parameters: t.inputSchema,
          };
          if (t.description) decl["description"] = t.description;
          return decl;
        }),
      },
    ];
  }
}
