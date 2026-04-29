/**
 * VercelClient unit tests — D44 §1 (Slice 5.x.1).
 *
 * Goal: cover bidirectional translation between LLMRequest/LLMResponse and
 * Vercel `LanguageModelV2` shapes without touching a real provider. We
 * implement a `MockLanguageModelV2` that records `doGenerate`/`doStream`
 * calls and emits canned content/stream parts.
 *
 * Coverage:
 *   - toV2Prompt: system + user/assistant/tool roles + tool_result wrap
 *   - fromV2Content: text / reasoning / tool-call (string input parsed) / image (base64)
 *   - fromV2FinishReason: each unified reason → StopReason
 *   - fromV2Usage: cachedInputTokens → cacheReadTokens
 *   - generate: end-to-end shape
 *   - stream: id → numeric index, text/reasoning/tool-input flows, usage + end
 *   - stream: error part → throws
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  VercelClient,
  fromV2Content,
  fromV2FinishReason,
  fromV2Usage,
  toV2Prompt,
} from "../vercel-client.js";

interface MockGenerateResult {
  content: LanguageModelV2Content[];
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  responseId?: string;
  responseModelId?: string;
}

function mockModel(opts: {
  generateResult?: MockGenerateResult;
  streamParts?: LanguageModelV2StreamPart[];
  onCall?: (call: LanguageModelV2CallOptions) => void;
} = {}): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "mock.test",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate(callOpts) {
      opts.onCall?.(callOpts);
      const r = opts.generateResult ?? {
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      return {
        content: r.content,
        finishReason: r.finishReason,
        usage: r.usage,
        warnings: [],
        response: {
          id: r.responseId,
          modelId: r.responseModelId,
        } as { id?: string; modelId?: string },
      };
    },
    async doStream(callOpts) {
      opts.onCall?.(callOpts);
      const parts = opts.streamParts ?? [];
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return { stream };
    },
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

// ─── pure conversion helpers ────────────────────────────────────────────

describe("toV2Prompt", () => {
  it("emits a system message when LLMRequest.system is a string", () => {
    const prompt = toV2Prompt({
      system: "you are alpha",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(prompt[0]).toEqual({ role: "system", content: "you are alpha" });
    expect(prompt[1]?.role).toBe("user");
  });

  it("collapses content-block system into joined text", () => {
    const prompt = toV2Prompt({
      system: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(prompt[0]).toEqual({ role: "system", content: "line1\nline2" });
  });

  it("wraps user string content as a single text part", () => {
    const prompt = toV2Prompt({ messages: [{ role: "user", content: "hi" }] });
    expect(prompt[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("wraps tool message string content as tool-result with text output", () => {
    const prompt = toV2Prompt({
      messages: [
        { role: "tool", content: "result", toolCallId: "tu_1" },
      ],
    });
    expect(prompt[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu_1",
          toolName: "",
          output: { type: "text", value: "result" },
        },
      ],
    });
  });

  it("converts tool_result block isError=true to error-text output", () => {
    const prompt = toV2Prompt({
      messages: [
        {
          role: "tool",
          content: [
            { type: "tool_result", toolCallId: "tu_1", content: "boom", isError: true },
          ],
        },
      ],
    });
    expect(prompt[0]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu_1",
          output: { type: "error-text", value: "boom" },
        },
      ],
    });
  });

  it("converts assistant tool_use block to V2 tool-call part", () => {
    const prompt = toV2Prompt({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } }],
        },
      ],
    });
    expect(prompt[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu_1",
          toolName: "bash",
          input: { cmd: "ls" },
        },
      ],
    });
  });

  it("converts assistant thinking block to V2 reasoning part", () => {
    const prompt = toV2Prompt({
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "let me think" }],
        },
      ],
    });
    expect(prompt[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "reasoning", text: "let me think" }],
    });
  });

  it("converts user image block (base64) to V2 file part", () => {
    const prompt = toV2Prompt({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    });
    expect(prompt[0]).toMatchObject({
      role: "user",
      content: [{ type: "file", data: "AAAA", mediaType: "image/png" }],
    });
  });

  it("drops non-text/file blocks from user role per V2 prompt schema", () => {
    const prompt = toV2Prompt({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "thinking", thinking: "should drop" },
          ],
        },
      ],
    });
    expect(prompt[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
  });
});

describe("fromV2Content", () => {
  it("maps text / reasoning / tool-call (parsed input) / file image", () => {
    const out = fromV2Content([
      { type: "text", text: "hello" },
      { type: "reasoning", text: "thought" },
      { type: "tool-call", toolCallId: "tu_1", toolName: "bash", input: '{"cmd":"ls"}' },
      {
        type: "file",
        data: "AAAA",
        mediaType: "image/png",
      },
    ]);
    expect(out).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "thought" },
      { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
      {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: "AAAA" },
      },
    ]);
  });

  it("falls back to raw string when tool-call.input is not valid JSON", () => {
    const out = fromV2Content([
      { type: "tool-call", toolCallId: "tu_1", toolName: "x", input: "not-json" },
    ]);
    expect(out).toEqual([
      { type: "tool_use", id: "tu_1", name: "x", input: "not-json" },
    ]);
  });

  it("drops file with non-image media type and unsupported source types", () => {
    const out = fromV2Content([
      { type: "file", data: "AAAA", mediaType: "application/pdf" },
      { type: "source", sourceType: "url", id: "s_1", url: "https://x" },
    ] as LanguageModelV2Content[]);
    expect(out).toEqual([]);
  });
});

describe("fromV2FinishReason", () => {
  it("maps each V2 unified reason to StopReason", () => {
    expect(fromV2FinishReason("stop")).toBe("end_turn");
    expect(fromV2FinishReason("length")).toBe("max_tokens");
    expect(fromV2FinishReason("content-filter")).toBe("refusal");
    expect(fromV2FinishReason("tool-calls")).toBe("tool_use");
    expect(fromV2FinishReason("error")).toBe("end_turn");
    expect(fromV2FinishReason("other")).toBe("end_turn");
    expect(fromV2FinishReason("unknown")).toBe("end_turn");
    expect(fromV2FinishReason(undefined)).toBe("end_turn");
  });
});

describe("fromV2Usage", () => {
  it("flattens cachedInputTokens to cacheReadTokens", () => {
    const out = fromV2Usage({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 4,
    });
    expect(out).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 4,
    });
  });

  it("zeros undefined token counts", () => {
    const out = fromV2Usage({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    expect(out).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ─── VercelClient generate / stream ─────────────────────────────────────

describe("VercelClient.generate", () => {
  it("returns LLMResponse with content / stopReason / usage", async () => {
    const client = new VercelClient(
      mockModel({
        generateResult: {
          content: [{ type: "text", text: "hi" }],
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          responseId: "msg_xyz",
          responseModelId: "claude-test",
        },
      }),
    );
    const out = await client.generate({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.id).toBe("msg_xyz");
    expect(out.model).toBe("claude-test");
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.stopReason).toBe("end_turn");
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it("synthesizes id when response.id is missing and falls back to constructor modelId", async () => {
    const client = new VercelClient(mockModel());
    const out = await client.generate({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.id).toMatch(/^vercel-/);
    expect(out.model).toBe("mock-model");
  });

  it("forwards maxTokens / temperature / stop / tools to the model", async () => {
    let received: LanguageModelV2CallOptions | undefined;
    const client = new VercelClient(
      mockModel({ onCall: (c) => (received = c) }),
      { defaultMaxTokens: 999 },
    );
    await client.generate({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      stop: ["END"],
      tools: [
        {
          name: "bash",
          description: "run shell",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(received?.maxOutputTokens).toBe(999);
    expect(received?.temperature).toBe(0.2);
    expect(received?.stopSequences).toEqual(["END"]);
    expect(received?.tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "run shell",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("rejects non-v2 spec version at construction", () => {
    expect(
      () =>
        new VercelClient({
          ...mockModel(),
          specificationVersion: "v1",
        } as unknown as LanguageModelV2),
    ).toThrow(/spec/i);
  });
});

describe("VercelClient.stream", () => {
  it("emits start → text content_block_* → end with usage", async () => {
    const client = new VercelClient(
      mockModel({
        streamParts: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "hel" },
          { type: "text-delta", id: "t1", delta: "lo" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            finishReason: "stop",
          },
        ],
      }),
    );
    const chunks = await collect(
      client.stream({ messages: [{ role: "user", content: "hi" }] }),
    );

    expect(chunks[0]).toMatchObject({ type: "start", model: "mock-model" });
    expect(chunks[1]).toEqual({
      type: "content_block_start",
      index: 0,
      block: { type: "text", text: "" },
    });
    expect(chunks[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hel" },
    });
    expect(chunks[3]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo" },
    });
    expect(chunks[4]).toEqual({ type: "content_block_stop", index: 0 });
    // chunks[5] = usage chunk from finish
    expect(chunks[5]).toMatchObject({ type: "usage" });
    // chunks[6] = end
    expect(chunks[chunks.length - 1]).toEqual({
      type: "end",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("assigns separate indices to multiple V2 stream ids", async () => {
    const client = new VercelClient(
      mockModel({
        streamParts: [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
          { type: "tool-input-start", id: "tu1", toolName: "bash" },
          { type: "tool-input-delta", id: "tu1", delta: '{"x":' },
          { type: "tool-input-delta", id: "tu1", delta: "1}" },
          { type: "tool-input-end", id: "tu1" },
          {
            type: "finish",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: "tool-calls",
          },
        ],
      }),
    );
    const chunks = await collect(
      client.stream({ messages: [{ role: "user", content: "hi" }] }),
    );

    const blockStarts = chunks.filter((c) => c.type === "content_block_start");
    expect(blockStarts).toHaveLength(2);
    expect(blockStarts[0]).toMatchObject({ index: 0, block: { type: "text" } });
    expect(blockStarts[1]).toMatchObject({
      index: 1,
      block: { type: "tool_use", id: "tu1", name: "bash", input: {} },
    });

    const inputDeltas = chunks.filter(
      (c) => c.type === "content_block_delta" && c.delta.type === "input_json_delta",
    );
    expect(inputDeltas).toHaveLength(2);

    expect(chunks[chunks.length - 1]).toMatchObject({
      type: "end",
      stopReason: "tool_use",
    });
  });

  it("converts reasoning-* parts to thinking content_block_*", async () => {
    const client = new VercelClient(
      mockModel({
        streamParts: [
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "step 1" },
          { type: "reasoning-end", id: "r1" },
          {
            type: "finish",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: "stop",
          },
        ],
      }),
    );
    const chunks = await collect(
      client.stream({ messages: [{ role: "user", content: "hi" }] }),
    );
    const start = chunks.find((c) => c.type === "content_block_start");
    expect(start).toMatchObject({ block: { type: "thinking", thinking: "" } });
    const delta = chunks.find((c) => c.type === "content_block_delta");
    expect(delta).toMatchObject({
      delta: { type: "thinking_delta", thinking: "step 1" },
    });
  });

  it("uses response-metadata id/modelId for the start chunk when present", async () => {
    const client = new VercelClient(
      mockModel({
        streamParts: [
          { type: "stream-start", warnings: [] },
          {
            type: "response-metadata",
            id: "msg_real",
            modelId: "claude-real",
          },
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: "stop",
          },
        ],
      }),
    );
    const chunks = await collect(
      client.stream({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(chunks[0]).toEqual({
      type: "start",
      id: "msg_real",
      model: "claude-real",
    });
  });

  it("throws when the stream emits an error part", async () => {
    const client = new VercelClient(
      mockModel({
        streamParts: [{ type: "error", error: new Error("boom") }],
      }),
    );
    await expect(
      collect(client.stream({ messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toThrow(/boom/);
  });

  it("emits end chunk even when finish part is missing", async () => {
    const client = new VercelClient(
      mockModel({
        streamParts: [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
        ],
      }),
    );
    const chunks = await collect(
      client.stream({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(chunks[chunks.length - 1]).toMatchObject({
      type: "end",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
