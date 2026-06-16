// Anthropic Messages API ProviderPort 계약 — mock fetch(SSE 재현, 실 API 없이).
// anthropic·claude-code-cli 공용 어댑터. SSE = message_start / content_block_{start,delta,stop} / message_delta / message_stop.
import { describe, it, expect } from "vitest";
import { makeAnthropicProvider } from "../main/adapters/anthropic-provider.js";
import type { ProviderChunk, ProviderConfig, ChatMessage } from "../main/domain/chat.js";

function sseFetch(lines: string[], box: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> }) {
  const enc = new TextEncoder();
  return async (url: string, init: { headers: Record<string, string>; body: string }) => {
    box.url = url;
    box.headers = init.headers;
    box.body = JSON.parse(init.body) as Record<string, unknown>;
    let i = 0;
    const reader = { read: async () => (i < lines.length ? { done: false, value: enc.encode(lines[i++]) } : { done: true }), cancel() {} };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
  };
}
async function collect(it: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const cfg: ProviderConfig = { provider: "anthropic", model: "claude-sonnet-4-6" };

describe("makeAnthropicProvider — Messages API SSE", () => {
  it("text_delta→text, tool_use(input_json_delta)→toolUse, message_delta usage→usage, finish", async () => {
    const lines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5}}}\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}}\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"하세요"}}\n',
      'data: {"type":"content_block_stop","index":0}\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_time","input":{}}}\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tz\\":"}}\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"KST\\"}"}}\n',
      'data: {"type":"content_block_stop","index":1}\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n',
      'data: {"type":"message_stop"}\n',
    ];
    const box: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
    const p = makeAnthropicProvider({ baseUrl: "https://api.anthropic.com", apiKey: "K", model: "claude-sonnet-4-6", fetch: sseFetch(lines, box) as never });
    const chunks = await collect(p.chat(cfg, [{ role: "user", content: "몇시?" }], {
      systemPrompt: "너는 비서다",
      tools: [{ name: "get_time", description: "시간", parameters: { type: "object", properties: { tz: { type: "string" } } } }],
    }));

    expect(chunks.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("안녕하세요");
    expect(chunks.find((c) => c.kind === "toolUse")).toMatchObject({ id: "toolu_1", name: "get_time", args: { tz: "KST" } });
    expect(chunks.find((c) => c.kind === "usage")).toMatchObject({ inputTokens: 15, outputTokens: 20 }); // input(10)+cache_read(5)
    expect(chunks[chunks.length - 1].kind).toBe("finish");

    // 요청 와이어
    expect(box.url).toBe("https://api.anthropic.com/v1/messages");
    expect(box.headers?.["x-api-key"]).toBe("K");
    expect(box.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(box.body?.model).toBe("claude-sonnet-4-6");
    expect(box.body?.stream).toBe(true);
    const system = box.body?.system as Array<{ text: string; cache_control: unknown }>;
    expect(system[0].text).toContain("너는 비서다");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" }); // prompt caching
    expect((box.body?.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "get_time", description: "시간" });
    expect(box.body?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "몇시?" }] }]);
  });

  it("assistant toolCalls→tool_use, tool role→tool_result(연속 병합) 매핑", async () => {
    const box: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
    const p = makeAnthropicProvider({ baseUrl: "https://api.anthropic.com", apiKey: "K", fetch: sseFetch(['data: {"type":"message_stop"}\n'], box) as never });
    const msgs: ChatMessage[] = [
      { role: "user", content: "시간 알려줘" },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "get_time", args: { tz: "KST" } }] },
      { role: "tool", toolCallId: "toolu_1", content: "3pm" },
    ];
    await collect(p.chat(cfg, msgs, {}));
    expect(box.body?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "시간 알려줘" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_time", input: { tz: "KST" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "3pm" }] },
    ]);
    expect(box.body?.system).toBeUndefined(); // systemPrompt 없으면 system 생략
  });

  it("error 이벤트 → throw(handler catch=error 방출)", async () => {
    const box: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
    const p = makeAnthropicProvider({ baseUrl: "https://api.anthropic.com", apiKey: "K", fetch: sseFetch(['data: {"type":"error","error":{"type":"overloaded_error"}}\n'], box) as never });
    await expect(collect(p.chat(cfg, [{ role: "user", content: "hi" }], {}))).rejects.toThrow(/Anthropic stream error/);
  });
});
