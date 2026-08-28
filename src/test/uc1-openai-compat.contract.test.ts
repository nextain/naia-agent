// OpenAI-compat(GLM/zai) ProviderPort 계약 테스트 — mock fetch(SSE 재현, 실 API 없이).
import { describe, it, expect } from "vitest";
import { makeOpenAICompatProvider, STREAM_IDLE_TIMEOUT_MS } from "../main/adapters/openai-compat-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
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
