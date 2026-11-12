import { wireAgentUC1 } from "../main/composition/index.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
// OpenAI-compat(GLM/zai) ProviderPort 계약 테스트 — mock fetch(SSE 재현, 실 API 없이).
import { describe, it, expect } from "vitest";
import { makeOpenAICompatProvider, STREAM_IDLE_TIMEOUT_MS } from "../main/adapters/openai-compat-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { conversationMessageCost } from "../main/adapters/budgeted-conversation.js";
import { NAIA_PI_MODELS, NAIA_PI_PROVIDER, buildNaiaPiModelsConfig, naiaGatewayContextWindow } from "../main/adapters/naia-pi-provider.js";
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
  it("separates streamed think tags from the final answer", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"<thi"}}]}\n',
      'data: {"choices":[{"delta":{"content":"nk>private</think>Final"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out).toContainEqual({ kind: "thinking", text: "private" });
    expect(out).toContainEqual({ kind: "text", text: "Final" });
  });

  it("maps delta.reasoning strings and objects to thinking chunks", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"reasoning":"Motif reasoning string"}}]}\n',
      'data: {"choices":[{"delta":{"reasoning":{"content":"Motif reasoning object"}}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out).toContainEqual({ kind: "thinking", text: "Motif reasoning string" });
    expect(out).toContainEqual({ kind: "thinking", text: "Motif reasoning object" });
  });

  it("!ok → throw", async () => {
    await expect(collect(prov([], { ok: false, status: 401 }).chat(cfg, [], {}))).rejects.toThrow(/401/);
  });
  it("finish_reason=length is reported as truncation", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":7590,"completion_tokens":602}}\n',
      "data: [DONE]\n",
    ];
    await expect(collect(prov(lines).chat(cfg, [], {}))).rejects.toThrow(/truncated.*finish_reason=length/);
  });
  it("비-OK(429 등) 응답 본문을 throw 전에 취소 — dangling 소켓→libuv 어설션 방지(적대리뷰)", async () => {
    let cancelled = false;
    const fetch = async () => ({
      ok: false, status: 429, statusText: "Too Many Requests",
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => { cancelled = true; } }) },
    });
    await expect(collect(makeOpenAICompatProvider({ baseUrl: "https://x", apiKey: "k", fetch: fetch as never }).chat(cfg, [], {}))).rejects.toThrow(/429/);
    expect(cancelled).toBe(true); // 본문 reader.cancel() 호출됨
  });
  it("403 FastAPI detail 을 셸이 볼 오류 문자열에 붙인다", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode(JSON.stringify({ detail: "Insufficient credits" }));
    let cancelled = false;
    let sent = false;
    const fetch = async () => ({
      ok: false, status: 403, statusText: "Forbidden",
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
        cancel: async () => { cancelled = true; },
      }) },
    });
    await expect(collect(makeOpenAICompatProvider({ baseUrl: "https://api-dev.naia.land/v1", apiKey: "k", fetch: fetch as never }).chat(cfg, [], {})))
      .rejects.toThrow(/403 Forbidden: Insufficient credits/);
    expect(cancelled).toBe(true);
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
  it("FR-APP-6: inline image → OpenAI image_url data URI content part", async () => {
    const { fetch, box } = captureStream(["data: [DONE]\n"]);
    await collect(provF(fetch).chat(cfg, [{
      role: "user", content: "Screenshot", inlineImages: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
    }], {}));
    const messages = (box.body as { messages: Array<{ content: unknown }> }).messages;
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "Screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" } },
    ]);
  });

  it("DeepSeek ordinary chat forwards skill tools through the Naia resolver", async () => {
    const { fetch, box } = captureStream(["data: [DONE]\n"]);
    const config: ProviderConfig = { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k" };
    const provider = makeProviderResolver({ fetch: fetch as never }).resolve(config);
    await collect(provider.chat(config, [{ role: "user", content: "review" }], { tools }));
    expect(box.body?.tools).toEqual([
      { type: "function", function: { name: "echo", description: "echo it", parameters: { type: "object" } } },
    ]);
    expect(box.body?.max_tokens).toBe(16_384);
  });

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
  it("(g/#122) 게이트웨이 index 재사용(deepseek 실측 wire): 다른 id = 새 호출 경계 → 두 toolUse", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_t","function":{"name":"get_time","arguments":""},"type":"function"}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"function":{"arguments":"{\\"timezone\\": \\"Asia/Seoul\\"}","name":null},"type":"function"}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_w","function":{"name":"get_weather","arguments":""},"type":"function"}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"function":{"arguments":"{\\"city\\": \\"Seoul\\"}","name":null},"type":"function"}]}}]}\n',
      "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out)).toEqual([
      { kind: "toolUse", id: "call_t", name: "get_time", args: { timezone: "Asia/Seoul" } },
      { kind: "toolUse", id: "call_w", name: "get_weather", args: { city: "Seoul" } },
    ]);
  });
  it("(s/#122) 게이트웨이 스퓨리어스 `\"\"` 꼬리(무인자 도구 실측): 첫 완결 JSON 만 취함 / 내용 있는 꼬리는 여전히 throw", async () => {
    const mk = (frags: string[]) => captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":""},"type":"function"}]}}]}\n',
      ...frags.map((f) =>
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"function":{"arguments":${JSON.stringify(f)},"name":null},"type":"function"}]}}]}\n`,
      ),
      "data: [DONE]\n",
    ]).fetch;
    const outEmpty = await collect(provF(mk(["{}", "\"\""])).chat(cfg, [], { tools }));
    expect(tu(outEmpty)).toEqual([{ kind: "toolUse", id: "c1", name: "echo", args: {} }]);
    const outArgs = await collect(provF(mk(["{\"q\":1}", "\"\""])).chat(cfg, [], { tools }));
    expect(tu(outArgs)).toEqual([{ kind: "toolUse", id: "c1", name: "echo", args: { q: 1 } }]);
    await expect(collect(provF(mk(["{}", "\"x\""])).chat(cfg, [], { tools }))).rejects.toThrow(/malformed/);
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
  it("(n) 손상 감지 fail-closed / (p) invalid index → throw / (q) 빈 name → throw / (r) non-object args → throw", async () => {
    // #122 — 같은 index 의 다른 id 는 이제 새 호출 경계다: 이 wire 는 두 번째 호출의 name 누락으로
    //        fail-closed 된다(원자성 유지 — 선행 호출도 미방출).
    await expect(collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"echo"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","function":{"arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/missing name/);
    // 같은 호출(같은 id) 안에서 name 이 바뀌는 것은 여전히 손상 → conflict throw.
    await expect(collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"echo"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"other","arguments":"{}"}}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/conflict/);
    await expect(collect(provF(captureStream(['data: {"choices":[{"delta":{"tool_calls":[{"index":-1,"id":"c","function":{"name":"x"}}]}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/index/);
    await expect(collect(provF(captureStream(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"arguments":"{}"}}]}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/missing name/);
    await expect(collect(provF(captureStream(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"echo","arguments":"[1,2]"}}]}}]}\n', "data: [DONE]\n"]).fetch).chat(cfg, [], { tools }))).rejects.toThrow(/not an object/);
  });
  it("(o/#122) 새 경계의 미지원 type → 그 호출만 제외, 선행 유효 호출은 방출", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"echo"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","type":"code_interpreter"}]}}]}\n', "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out)).toEqual([{ kind: "toolUse", id: "a", name: "echo", args: {} }]);
  });
  it("(t) 첫 조각 type 'function' + 이어지는 조각 'type': null (게이트웨이 SSE 모양) → 도구 호출 하나로 모임", async () => {
    const out = await collect(provF(captureStream([
      'data: {"id":"chatcmpl-test-1","choices":[{"delta":{"audio":null,"content":null,"function_call":null,"refusal":null,"role":null,"tool_calls":[{"index":0,"id":"chatcmpl-tool-test01","function":{"arguments":null,"name":"get_time"},"type":"function"}],"reasoning":null},"index":0,"finish_reason":null,"logprobs":null,"token_ids":null}],"model":"motif-3","object":"chat.completion.chunk"}\n',
      'data: {"id":"chatcmpl-test-1","choices":[{"delta":{"audio":null,"content":null,"function_call":null,"refusal":null,"role":null,"tool_calls":[{"index":0,"id":null,"function":{"arguments":"{\\"timezone\\": \\"Asia/Seoul\\"}","name":null},"type":null}],"reasoning":null},"index":0,"finish_reason":null,"logprobs":null,"token_ids":null}],"model":"motif-3","object":"chat.completion.chunk"}\n',
      'data: {"id":"chatcmpl-test-1","choices":[{"delta":{"audio":null,"content":null,"function_call":null,"refusal":null,"role":null,"tool_calls":null,"reasoning":null},"index":0,"finish_reason":"tool_calls","logprobs":null,"stop_reason":6,"token_ids":null}],"model":"motif-3","object":"chat.completion.chunk"}\n',
      "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out)).toEqual([
      { kind: "toolUse", id: "chatcmpl-tool-test01", name: "get_time", args: { timezone: "Asia/Seoul" } },
    ]);
  });
  it("(u) 첫 조각부터 type null 인 경우도 받아들임", async () => {
    const out = await collect(provF(captureStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_null_type","type":null,"function":{"name":"echo","arguments":"{\\"text\\":\\"ok\\"}"}}]}}]}\n',
      "data: [DONE]\n",
    ]).fetch).chat(cfg, [], { tools }));
    expect(tu(out)).toEqual([
      { kind: "toolUse", id: "call_null_type", name: "echo", args: { text: "ok" } },
    ]);
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

// ── #114 — deepseek [THINK] 대괄호 태그 정규화 + 스트림 idle 데드라인 (FR-THINK-5·6) ──
describe("#114 deepseek [THINK] 정규화 (FR-THINK-5)", () => {
  it("① [THINK]x[/THINK]y → thinking=x, text=y (대소문자 무관)", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"[THINK]내부 추론[/THINK]최종 답"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out).toContainEqual({ kind: "thinking", text: "내부 추론" });
    expect(out).toContainEqual({ kind: "text", text: "최종 답" });
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("최종 답");
  });
  it("② 미닫힘 [THINK]x 스트림종료 → thinking 으로 flush(text 누출 0 — 셸 노출 사고 차단)", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"[THINK]새면 안 되는 추론 원문"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "text")).toEqual([]); // text 무누출
    expect(out.filter((c) => c.kind === "thinking").map((c) => (c as { text: string }).text).join("")).toBe("새면 안 되는 추론 원문");
  });
  it("③ 청크 경계 분할 태그([TH / INK]·[/THI / NK]) 재조립(부분 태그 버퍼링)", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"[TH"}}]}\n',
      'data: {"choices":[{"delta":{"content":"INK]속마음[/THI"}}]}\n',
      'data: {"choices":[{"delta":{"content":"NK]겉말"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "thinking").map((c) => (c as { text: string }).text).join("")).toBe("속마음");
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("겉말");
  });
  it("④ 계약(각오한 트레이드오프): 본문 중간 literal [think] (닫힘쌍 없음) 이후는 thinking 으로 — text 로는 절대 새지 않는다", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"태그 설명: [think] 라고 쓰면 생각이 시작됩니다"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    // 여는 태그 앞까지는 text, 이후(닫힘 없음)는 thinking flush — 오인 방향은 항상 "숨김"이지 "노출"이 아니다.
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("태그 설명: ");
    expect(out.filter((c) => c.kind === "thinking").map((c) => (c as { text: string }).text).join("")).toBe(" 라고 쓰면 생각이 시작됩니다");
  });
  it("flavor 대칭: [THINK] 는 [/THINK] 로만 닫힌다(</think> 는 내용) + 꺾쇠 <think> 무회귀", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"[THINK]a</think>b[/THINK]c<think>d</think>e"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "thinking").map((c) => (c as { text: string }).text).join("")).toBe("a</think>bd");
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("ce");
  });
  it("⑥ [THINKING] 는 [THINK] 접두로 오인되지 않음 — 전체 태그 요구 (thinking 으로 오분류되지 않고 text 로 방출)", async () => {
    const out = await collect(prov([
      'data: {"choices":[{"delta":{"content":"[THINKING] Hello world"}}]}\n',
      "data: [DONE]\n",
    ]).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "thinking")).toEqual([]);
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("[THINKING] Hello world");
  });
});

describe("#114 스트림 idle 데드라인 (FR-THINK-6)", () => {
  const enc = new TextEncoder();
  it("⑤ 무수신 hang → 데드라인 내 에러 throw + reader.cancel(터널 hang 이 턴을 영구 점유하지 못한다)", async () => {
    let cancelled = false;
    let reads = 0;
    const reader = {
      read: () => {
        reads++;
        return reads === 1
          ? Promise.resolve({ done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"부분"}}]}\n') })
          : new Promise<never>(() => {}); // 이후 영구 무수신(게이트웨이 hang 재현)
      },
      cancel: async () => { cancelled = true; },
    };
    const fetch = async () => ({ ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } });
    const provider = makeOpenAICompatProvider({ baseUrl: "https://x", apiKey: "k", idleTimeoutMs: 30, fetch: fetch as never });
    await expect(collect(provider.chat(cfg, [], {}))).rejects.toThrow(/idle/);
    expect(cancelled).toBe(true); // finally 가 연결 정리
  });
  it("청크가 계속 오면 idle 데드라인은 발화하지 않는다(총시간 기준 금지 — 정상 장문 무절단)", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"1"}}]}\n',
      'data: {"choices":[{"delta":{"content":"2"}}]}\n',
      'data: {"choices":[{"delta":{"content":"3"}}]}\n',
      "data: [DONE]\n",
    ];
    let i = 0;
    const reader = {
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        setTimeout(() => resolve(i >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[i++]!) }), 20);
      }),
      cancel: async () => {},
    };
    const fetch = async () => ({ ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } });
    // 데드라인 50ms > 청크 간격 20ms — 총 소요(80ms+)가 데드라인을 넘어도 끊기지 않는다(idle 기준).
    const provider = makeOpenAICompatProvider({ baseUrl: "https://x", apiKey: "k", idleTimeoutMs: 50, fetch: fetch as never });
    const out = await collect(provider.chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text).join("")).toBe("123");
    expect(out.at(-1)).toEqual({ kind: "finish" });
  });
  it("기본 데드라인 = 45s 상수", () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(45_000);
  });
});

describe("context overflow request budget", () => {
  for (const scenario of ["success", "twice", "other"] as const) {
    it(`400 retry: ${scenario}`, async () => {
      const requests: any[] = [];
      const fetch = async (_url: string, init: { body: string }) => {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1 || scenario === "twice") {
          const detail = scenario === "other" ? "invalid tool schema" : "maximum context length: input_tokens=8193 max_model_len=8192";
          return new Response(detail, { status: 400 });
        }
        return new Response("data: [DONE]\n");
      };
      const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "test", fetch: fetch as never });
      const messages = [...Array.from({ length: 12 }, () => ({ role: "assistant" as const, content: "x".repeat(1000) })), { role: "user" as const, content: "latest" }];
      const result = collect(p.chat(cfg, messages, { systemPrompt: "system" }));
      if (scenario === "success") await result;
      else if (scenario === "twice") await expect(result).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
      else await expect(result).rejects.toThrow(/400/);
      expect(requests).toHaveLength(scenario === "other" ? 1 : 2);
      if (requests.length === 2) {
        expect(JSON.stringify(requests[1].messages).length).toBeLessThan(JSON.stringify(requests[0].messages).length * 0.6);
        expect(requests[1].messages[0]).toEqual({ role: "system", content: "system" });
        expect(requests[1].messages.at(-1).content).toBe("latest");
      }
    });
  }
  it("subtracts system, tool schema and output reservation before history", async () => {
    let request: any;
    const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "test", maxTokens: 1000,
      fetch: (async (_u: string, init: { body: string }) => { request = JSON.parse(init.body); return new Response("data: [DONE]\n"); }) as never });
    const messages = [...Array.from({ length: 20 }, () => ({ role: "assistant" as const, content: "x".repeat(1000) })), { role: "user" as const, content: "latest" }];
    await collect(p.chat(cfg, messages, { systemPrompt: "s".repeat(4000), tools: [{ name: "t", description: "d".repeat(4000), parameters: {} }] }));
    expect(JSON.stringify(request.messages).length + JSON.stringify(request.tools).length).toBeLessThanOrEqual(20000);
    expect(request.max_tokens).toBe(1000);
  });
});

it("counts echoed reasoning, preserves latest user/tool round and uses known context limit", async () => {
  let request: any;
  const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "test", contextWindow: 1000, maxTokens: 100, echoReasoningContent: true,
    fetch: (async (_u: string, init: { body: string }) => { request = JSON.parse(init.body); return new Response("data: [DONE]\n"); }) as never });
  const latest = [{ role: "user" as const, content: "latest" }, { role: "assistant" as const, content: "", toolCalls: [{ id: "new", name: "t", args: {} }] }, { role: "tool" as const, content: "new result", toolCallId: "new" }];
  await collect(p.chat(cfg, [{ role: "assistant", content: "old", reasoningContent: "한".repeat(2000), toolCalls: [{ id: "old", name: "t", args: {} }] }, { role: "tool", content: "old result", toolCallId: "old" }, ...latest], { systemPrompt: "system" }));
  expect(request.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(request.messages[2].tool_calls[0].id).toBe("new");
  expect(request.messages[3].tool_call_id).toBe("new");
});
it("does not retry context overflow after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "test",
    fetch: (async () => { calls++; controller.abort(); return new Response("maximum context length", { status: 400 }); }) as never });
  await expect(collect(p.chat(cfg, [{ role: "user", content: "latest" }], { signal: controller.signal }))).rejects.toThrow(/400/);
  expect(calls).toBe(1);
});

// Deliberately independent synthetic tokenizer: one token per three UTF-8 bytes.
// This exercises real HTTP framing and accumulated Korean history, not model quality.
it("8192 HTTP server: Korean 20 turns, 20 responses and zero context 400s", async () => {
  const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);
  let requests = 0, overflows = 0, maxInput = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const input = tokens({ messages: body.messages, tools: body.tools });
    requests++; maxInput = Math.max(maxInput, input);
    if (input > 8192) {
      overflows++;
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "maximum context length is 8192 tokens", code: "context_length_exceeded" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"한국어 응답입니다."}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const config: ProviderConfig = { provider: "vllm", model: "qwen-test", contextWindow: 8192,
      vllmHost: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
    const chunks: import("../main/domain/chat.js").AgentEmit[] = [];
    const tools = [{ name: "radio", description: "라디오 곡을 선택합니다.", parameters: { type: "object" } }];
    const agent = wireAgentUC1({ defaultConfig: config, resolver: makeProviderResolver(),
      egress: { emit: (_id, event) => { chunks.push(event); } }, diag: { log() {} },
      toolExecutor: { specs: () => tools, execute: async () => ({ output: "ok" }) },
    });
    const messages: import("../main/domain/chat.js").ChatMessage[] = [];
    let replies = 0;
    for (let turn = 1; turn <= 20; turn++) {
      messages.push({ role: "user", content: `${turn}번째 이야기입니다. ` + "오늘 라디오에서는 한국어 대화를 나누며 음악과 날씨에 대해 이야기합니다. ".repeat(35) });
      chunks.length = 0;
      await agent.handler.onChatRequest({ kind: "chat", requestId: `turn${turn}`, messages, systemPrompt: "한국어 라디오 진행자입니다.", enableTools: true });
      expect(chunks.filter((chunk) => chunk.kind === "error")).toHaveLength(0);
      const text = chunks.filter((c) => c.kind === "text").map((c) => c.text).join("");
      expect(text).toBe("한국어 응답입니다.");
      expect(chunks.at(-1)).toEqual({ kind: "finish" });
      messages.push({ role: "assistant", content: text }); replies++;
    }
    expect(tokens({ messages, tools })).toBeGreaterThan(8192); // proves trimming is necessary
    expect({ requests, replies, overflows }).toEqual({ requests: 20, replies: 20, overflows: 0 });
    expect(maxInput).toBeLessThanOrEqual(8192);
    // Negative control: this server must reject accumulated untrimmed history.
    const control = await fetch(`${config.vllmHost}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, tools }),
    });
    expect(control.status).toBe(400);
    expect(await control.text()).toContain("maximum context length");
    expect(overflows).toBe(1); // intentional control, after all 20 successful turns

  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("ProviderConfig contextWindow changes native resolver wire history", async () => {
  const counts: number[] = [];
  const resolver = makeProviderResolver({ fetch: (async (_url: string, init: { body: string }) => {
    counts.push(JSON.parse(init.body).messages.length);
    return new Response("data: [DONE]\n");
  }) as never });
  const messages = [...Array.from({ length: 30 }, () => ({ role: "assistant" as const, content: "x".repeat(1000) })), { role: "user" as const, content: "latest" }];
  for (const contextWindow of [1000, 8192]) {
    const config = { provider: "vllm", model: "qwen", contextWindow };
    await collect(resolver.resolve(config).chat(config, messages, {}));
  }
  expect(counts[0]).toBeLessThan(counts[1]!);
});

it.each(["unknown parameter input_tokens", "invalid max_model_len option"])("does not retry unrelated 400 mentioning token fields: %s", async (detail) => {
  let calls = 0;
  const provider = makeOpenAICompatProvider({ baseUrl: "https://test.invalid", apiKey: "test",
    fetch: (async () => { calls++; return new Response(detail, { status: 400 }); }) as never });
  await expect(collect(provider.chat(cfg, [{ role: "user", content: "hi" }], {}))).rejects.toThrow(/400/);
  expect(calls).toBe(1);
});

it("composition uses contextWindow above 6000 and excludes radio-disabled tools on wire", async () => {
  const requests: any[] = [];
  const resolver = makeProviderResolver({ fetch: (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body)); return new Response('data: {"choices":[{"delta":{"content":"완료했습니다."}}]}\ndata: [DONE]\n');
  }) as never });
  const agent = wireAgentUC1({ resolver, egress: { emit() {} }, diag: { log() {} },
    toolExecutor: { specs: () => [
      { name: "radio", description: "라디오", parameters: {} },
      { name: "heavy", description: "x".repeat(10000), parameters: {} },
    ], execute: async () => ({ output: "ok" }) },
  });
  const messages = [...Array.from({ length: 40 }, () => ({ role: "assistant" as const, content: "한글".repeat(100) })), { role: "user" as const, content: "최신" }];
  for (const contextWindow of [6000, 32768]) {
    agent.setDefaultConfig({ provider: "vllm", model: "qwen", contextWindow });
    await agent.handler.onChatRequest({ kind: "chat", requestId: `r${contextWindow}`, messages,
      disabledSkills: ["heavy"], enableTools: true });
  }
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.length).toBeGreaterThan(requests[0].messages.length);
  expect(requests[1].messages.filter((m: any) => m.role !== "system")).toHaveLength(messages.length);
  expect(requests[1].tools.map((tool: any) => tool.function.name)).toContain("radio");
  expect(requests[1].tools.map((tool: any) => tool.function.name)).not.toContain("heavy");
});

it.each(["context window exceeded", "context-window-exceeded", "prompt too long", "too many input tokens"])("retries length variant once: %s", async (detail) => {
  let calls = 0;
  const provider = makeOpenAICompatProvider({ baseUrl: "https://test.invalid", apiKey: "test",
    fetch: (async () => ++calls === 1 ? new Response(detail, { status: 400 }) : new Response("data: [DONE]\n")) as never });
  const messages = [{ role: "assistant" as const, content: "x".repeat(1000) }, { role: "user" as const, content: "hi" }];
  expect((await collect(provider.chat(cfg, messages, {}))).at(-1)).toEqual({ kind: "finish" });
  expect(calls).toBe(2);
});

describe("#176 검수 지적 1·4·5 — 문맥 한도와 400 판별", () => {
  const history = [
    { role: "user" as const, content: "첫 번째 질문" },
    { role: "assistant" as const, content: "첫 번째 답변" },
    { role: "user" as const, content: "두 번째 질문" },
  ];
  it("게이트웨이 deepseek-v4-flash 는 출력 예약 16384 가 있어도 대화 기록을 지우지 않는다", async () => {
    let body: any;
    const resolver = makeProviderResolver({
      fetch: (async (_u: string, init: { body: string }) => { body = JSON.parse(init.body); return new Response("data: [DONE]\n"); }) as never,
    });
    const c = { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k" } as ProviderConfig;
    await collect(resolver.resolve(c).chat(c, history, { systemPrompt: "sys" }));
    expect(body.max_tokens).toBe(16_384);
    expect(body.messages.map((x: any) => x.content)).toEqual(["sys", ...history.map((x) => x.content)]);
  });
  it("문맥 한도를 모르는 공급자도 큰 maxTokens 때문에 기록이 0 이 되지 않는다", async () => {
    let body: any;
    const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "k", maxTokens: 16_384,
      fetch: (async (_u: string, init: { body: string }) => { body = JSON.parse(init.body); return new Response("data: [DONE]\n"); }) as never });
    await collect(p.chat(cfg, history, { systemPrompt: "sys" }));
    expect(body.messages).toHaveLength(4);
  });
  it("게이트웨이 모델 문맥 한도 표는 Pi 카탈로그와 같다", () => {
    const models = (buildNaiaPiModelsConfig() as any).providers[NAIA_PI_PROVIDER].models as { id: string; contextWindow: number }[];
    expect(models.map((m) => m.id).sort()).toEqual([...NAIA_PI_MODELS].sort());
    for (const m of models) {
      expect(naiaGatewayContextWindow(m.id)).toBe(m.contextWindow);
      expect(naiaGatewayContextWindow(m.id.toUpperCase())).toBe(m.contextWindow);
    }
    expect(naiaGatewayContextWindow("unknown-model")).toBeUndefined();
  });
  for (const [label, status, payload] of [
    ["stop 토큰 수 오류", 400, { error: { message: "stop sequences contain too many tokens (max 4)" } }],
    ["max_tokens 파라미터 오류", 400, { error: { message: "Requested max_tokens (16384) exceeds max_model_len (8192)" } }],
    ["max_completion_tokens 과대", 400, { error: { message: "'max_completion_tokens' is too large: 16384. This model's maximum context length is 8192 tokens" } }],
    ["본문 에코", 400, { detail: [{ msg: "field required", input: "prompt is too long maximum context length" }] }],
  ] as const) {
    it(`문맥 초과가 아닌 400(${label})은 재시도하지 않고 원래 오류를 낸다`, async () => {
      let calls = 0;
      const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "k",
        fetch: (async () => { calls++; return new Response(JSON.stringify(payload), { status }); }) as never });
      const err: any = await collect(p.chat(cfg, [{ role: "user", content: "hi" }], {})).catch((e) => e);
      expect(calls).toBe(1);
      expect(err.code).toBeUndefined();
      expect(err.message).toMatch(/400/);
    });
  }
  it("error.code=context_length_exceeded 는 문맥 초과로 보고, 최종 오류에 서버 상세를 남긴다", async () => {
    let calls = 0;
    const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "k",
      fetch: (async () => { calls++; return new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "This model's maximum context length is 8192 tokens." } }), { status: 400 }); }) as never });
    const messages = [...Array.from({ length: 6 }, () => ({ role: "assistant" as const, content: "x".repeat(1000) })), { role: "user" as const, content: "latest" }];
    const err: any = await collect(p.chat(cfg, messages, {})).catch((e) => e);
    expect(calls).toBe(2);
    expect(err.code).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect(err.message).toMatch(/^문맥 길이 초과: .*8192 tokens/);
  });
  // #176 rev2: 서버가 알려 준 한도의 여러 표기를 읽어 두 번째 요청을 실제 한도 안에 넣고,
  // "input or max_tokens 를 줄이라"는 안내가 붙은 진짜 초과도 문맥 초과로 본다.
  for (const form of [
    (cost: number) => `input length ${Math.ceil(cost)} exceeds max_model_len 2048`,
    (cost: number) => `prompt of ${Math.ceil(cost)} tokens exceeds max_model_len=2048`,
    (cost: number) => `input (${Math.ceil(cost)} tokens) exceeds max_model_len: 2048`,
    (cost: number) => `input ${Math.ceil(cost)} exceeds max_model_len (2048)`,
    () => "This model's maximum context length is 2048 tokens. Please reduce your input or max_tokens.",
  ]) {
    it(`서버 한도 안으로 줄여 두 번째 요청에서 성공한다: ${form(5000)}`, async () => {
      const costs: number[] = [];
      const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "k",
        fetch: (async (_u: string, init: { body: string }) => {
          const b = JSON.parse(init.body);
          const cost = b.messages.reduce((n: number, m: any) => n + conversationMessageCost(m), 0);
          costs.push(cost);
          if (cost <= 2048) return new Response("data: [DONE]\n");
          return new Response(JSON.stringify({ error: { message: form(cost) } }), { status: 400 });
        }) as never });
      const messages = [...Array.from({ length: 20 }, (_, i) => ({ role: "assistant" as const, content: String.fromCharCode(65 + i).repeat(1000) })), { role: "user" as const, content: "latest" }];
      await collect(p.chat({ provider: "vllm", model: "unknown-model" } as ProviderConfig, messages, {}));
      expect(costs).toHaveLength(2);
      expect(costs[1]).toBeLessThanOrEqual(2048);
    });
  }
  it("줄일 기록이 없으면 같은 요청을 다시 보내지 않는다", async () => {
    let calls = 0;
    const p = makeOpenAICompatProvider({ baseUrl: "https://test", apiKey: "k",
      fetch: (async () => { calls++; return new Response(JSON.stringify({ error: { message: "maximum context length is 2048 tokens" } }), { status: 400 }); }) as never });
    const err: any = await collect(p.chat(cfg, [{ role: "user", content: "x".repeat(20000) }], { systemPrompt: "sys" })).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.code).toBe("CONTEXT_WINDOW_EXCEEDED");
  });
});
