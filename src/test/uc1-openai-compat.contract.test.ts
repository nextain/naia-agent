// OpenAI-compat(GLM/zai) ProviderPort 계약 테스트 — mock fetch(SSE 재현, 실 API 없이).
import { describe, it, expect } from "vitest";
import { makeOpenAICompatProvider } from "../main/adapters/openai-compat-provider.js";
import type { ProviderChunk, ProviderConfig } from "../main/domain/chat.js";

function mockFetch(sseLines: string[], opts: { ok?: boolean; status?: number } = {}) {
  const enc = new TextEncoder();
  return async () => {
    if (opts.ok === false) return { ok: false, status: opts.status ?? 401, statusText: "err", body: null };
    let i = 0;
    const reader = { async read() { return i >= sseLines.length ? { done: true } : { done: false, value: enc.encode(sseLines[i++]!) }; }, async cancel() {} };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
  };
}
const cfg: ProviderConfig = { provider: "zai", model: "glm-4.6" };
const prov = (lines: string[], o = {}) => makeOpenAICompatProvider({ baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "test", fetch: mockFetch(lines, o) as never });
async function collect(g: AsyncIterable<ProviderChunk>) { const out: ProviderChunk[] = []; for await (const c of g) out.push(c); return out; }

describe("makeOpenAICompatProvider (GLM/openai SSE, mock)", () => {
  it("SSE delta.content → per-chunk text + usage + finish", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"안녕"}}]}\n',
      'data: {"choices":[{"delta":{"content":"하세요"}}]}\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
      "data: [DONE]\n",
    ];
    const out = await collect(prov(lines).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(out).toEqual([
      { kind: "text", text: "안녕" }, { kind: "text", text: "하세요" },
      { kind: "usage", inputTokens: 10, outputTokens: 5 }, { kind: "finish" },
    ]);
  });
  it("SSE 청크 경계가 줄 중간이어도 재조립", async () => {
    const lines = ['data: {"choices":[{"delta":{"content":"부분', '1"}}]}\n', 'data: {"choices":[{"delta":{"content":"부분2"}}]}\ndata: [DONE]\n'];
    const out = await collect(prov(lines).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text)).toEqual(["부분1", "부분2"]);
  });
  it("!ok → throw", async () => {
    await expect(collect(prov([], { ok: false, status: 401 }).chat(cfg, [], {}))).rejects.toThrow(/401/);
  });
  it("SSE error 이벤트 → throw", async () => {
    const lines = ['data: {"error":{"message":"bad key"}}\n'];
    await expect(collect(prov(lines).chat(cfg, [], {}))).rejects.toThrow(/error/);
  });
  it("손상/비data 줄 skip", async () => {
    const lines = [": ping\n", "data: not json\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];
    const out = await collect(prov(lines).chat(cfg, [], {}));
    expect(out.some((c) => c.kind === "text" && (c as { text: string }).text === "ok")).toBe(true);
  });
  it("deps.model 지정 시 config.model(naia-local) 대신 강제 — 미지정 시 config.model 유지", async () => {
    let sentBody: { model?: string } = {};
    const capture = async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, statusText: "OK", body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
    };
    // 오버라이드: UI=naia-local → GLM 으로 glm-4.6 강제
    await collect(makeOpenAICompatProvider({ baseUrl: "https://x", apiKey: "k", model: "glm-4.6", fetch: capture as never }).chat({ provider: "zai", model: "naia-local" }, [], {}));
    expect(sentBody.model).toBe("glm-4.6");
    // 미지정: 계약 기본 = config.model 그대로
    await collect(makeOpenAICompatProvider({ baseUrl: "https://x", apiKey: "k", fetch: capture as never }).chat({ provider: "zai", model: "glm-4.5" }, [], {}));
    expect(sentBody.model).toBe("glm-4.5");
  });
});

// ── §C slice 1b: tools 전송 + streaming tool_calls 재조립 ──
function captureStream(lines: string[]) {
  const enc = new TextEncoder();
  const box: { body?: Record<string, unknown> } = {};
  const fetch = async (_url: string, init: { body: string }) => {
    box.body = JSON.parse(init.body);
    let i = 0;
    const reader = { async read() { return i >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[i++]!) }; }, async cancel() {} };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
  };
  return { fetch, box };
}
const provF = (fetch: unknown) => makeOpenAICompatProvider({ baseUrl: "https://x", apiKey: "k", fetch: fetch as never });
const tools = [{ name: "echo", description: "echo it", parameters: { type: "object" } }];
const tu = (out: ProviderChunk[]) => out.filter((c) => c.kind === "toolUse") as Extract<ProviderChunk, { kind: "toolUse" }>[];

describe("§C slice 1b — tool_calls 재조립", () => {
  it("(a) tools 전달 → body.tools 매핑 / (g) assistant(toolCalls)+tool 메시지 매핑(content null·tool_call_id)", async () => {
    const { fetch, box } = captureStream(["data: [DONE]\n"]);
    await collect(provF(fetch).chat(cfg, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }] },
      { role: "tool", toolCallId: "c1", content: "x" },
    ], { tools }));
    const b = box.body as { tools?: { type: string; function: { name: string } }[]; messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[] };
    expect(b.tools?.[0]).toEqual({ type: "function", function: { name: "echo", description: "echo it", parameters: { type: "object" } } });
    const asst = b.messages.find((m) => m.role === "assistant")!;
    expect(asst.content).toBeNull(); // content "" + toolCalls → null
    expect((asst.tool_calls as { id: string; function: { name: string; arguments: string } }[])[0]).toEqual({ id: "c1", type: "function", function: { name: "echo", arguments: JSON.stringify({ text: "x" }) } });
    const toolMsg = b.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("c1");
  });
  it("(b) delta.tool_calls 다조각(id 첫조각·arguments 분할) 재조립 → 완전 toolUse + (c) text 혼합", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"content":"생각:"}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"echo","arguments":"{\\"te"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"xt\\":\\"hi\\"}"}}]}}]}\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n',
      "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(out.some((c) => c.kind === "text" && (c as { text: string }).text === "생각:")).toBe(true); // text 혼합
    expect(tu(out)).toEqual([{ kind: "toolUse", id: "call_a", name: "echo", args: { text: "hi" } }]); // 재조립
    // 순서: text → toolUse → usage → finish
    expect(out.map((c) => c.kind)).toEqual(["text", "toolUse", "usage", "finish"]);
  });
  it("(d) malformed args → throw / 빈 args → {}", async () => {
    await expect(collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"echo","arguments":"{bad"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/malformed/);
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"echo"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out)[0].args).toEqual({}); // 빈 args
  });
  it("(e) id 누락 → call_{index} 합성", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"name":"echo","arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out)[0].id).toBe("call_2");
  });
  it("(f) tools·tool-bearing 미전달 → text-only 회귀 없음", async () => {
    const out = await collect(provF(captureStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [{ role: "user", content: "q" }], {}));
    expect(out.map((c) => c.kind)).toEqual(["text", "finish"]);
  });
  it("(h) type!=='function' → 제외(yield 안 함)", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"code_interpreter","id":"c","function":{"name":"x","arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out).length).toBe(0);
  });
  it("(g·tool) tool 메시지 toolCallId 누락 → throw", async () => {
    await expect(collect(provF(captureStream(["data: [DONE]\n"]).fetch).chat(cfg, [{ role: "tool", content: "x" } as never], {}))).rejects.toThrow(/toolCallId/);
  });
  it("(j) 다중 call 중 뒤 손상 → 선행 toolUse 0건(원자성)", async () => {
    await expect(collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"echo","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"echo","arguments":"{bad"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/malformed/);
  });
  it("(m) 중복 provider id → throw", async () => {
    await expect(collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"dup","function":{"name":"echo","arguments":"{}"}},{"index":1,"id":"dup","function":{"name":"echo","arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/duplicate/);
  });
  it("(n) id 충돌 → finalize throw / (p) invalid index → throw / (q) 빈 name → throw / (r) non-object args → throw", async () => {
    await expect(collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"echo"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","function":{"arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/conflict/);
    await expect(collect(provF(captureStream(['data: {"choices":[{"delta":{"tool_calls":[{"index":-1,"id":"c","function":{"name":"x"}}]}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/index/);
    await expect(collect(provF(captureStream(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"arguments":"{}"}}]}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/missing name/);
    await expect(collect(provF(captureStream(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"echo","arguments":"[1,2]"}}]}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/not an object/);
  });
  it("(o) 충돌 후 excluded → 오류 없이 제외", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"echo"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","type":"code_interpreter"}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out).length).toBe(0); // excluded → 제외, conflict throw 없음
  });
  it("(i) [DONE] 후 EOF 와도 finalize 1회(이중 yield 없음) / (l) EOF-only finalize", async () => {
    const eofOnly = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"echo","arguments":"{}"}}]}}]}\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n', // [DONE] 없이 EOF
    ]).fetch).chat(cfg, [], { tools }));
    expect(eofOnly.map((c) => c.kind)).toEqual(["toolUse", "usage", "finish"]); // 정확히 1회
  });
  it("(k) finalize 전 aborted → toolUse·usage·finish 전부 미방출", async () => {
    const ac = new AbortController(); ac.abort();
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"echo","arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools, signal: ac.signal }));
    expect(out.length).toBe(0); // commit-point: abort 면 배치 전체 미방출
  });
});
