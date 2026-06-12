// UC provider 출처(provider provenance) 계약 테스트 — 라우팅·cost·resolver(baseUrl/auth) 단위.
// 계약: docs/progress/UC-provider-provenance-contract-2026-06-12.md
import { describe, it, expect } from "vitest";
import { resolveProviderRoute, labProxyBaseUrl, nativeBaseUrl } from "../main/domain/provider-route.js";
import { calculateCost } from "../main/domain/cost.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { ProviderConfig, AgentEmit, ChatRequest } from "../main/domain/chat.js";

const cfg = (over: Partial<ProviderConfig>): ProviderConfig => ({ provider: "gemini", model: "gemini-2.5-flash", ...over });

async function collect(stream: AsyncIterable<unknown>) { for await (const _ of stream) { /* drain */ } }

describe("provider-route (순수 라우팅)", () => {
  it("ollama → ollama (naiaKey 무관)", () => {
    expect(resolveProviderRoute(cfg({ provider: "ollama", naiaKey: "n" }))).toBe("ollama");
    expect(resolveProviderRoute(cfg({ provider: "ollama" }))).toBe("ollama");
  });
  it("naiaKey + cloud → lab-proxy", () => {
    expect(resolveProviderRoute(cfg({ provider: "gemini", naiaKey: "naia-123" }))).toBe("lab-proxy");
    expect(resolveProviderRoute(cfg({ provider: "openai", naiaKey: "naia-123" }))).toBe("lab-proxy");
  });
  it("naiaKey 없으면 native (키 직접)", () => {
    expect(resolveProviderRoute(cfg({ provider: "gemini" }))).toBe("native");
  });
  it("vllm 은 명시적 로컬 → naiaKey 있어도 native(lab-proxy 아님)", () => {
    expect(resolveProviderRoute(cfg({ provider: "vllm", naiaKey: "naia-123" }))).toBe("native");
  });
});

describe("baseUrl 해석", () => {
  it("lab-proxy 기본=api.nextain.io/v1(openai-compat 가 /chat/completions 붙임), override 우선", () => {
    expect(labProxyBaseUrl(cfg({}))).toBe("https://api.nextain.io/v1");
    expect(labProxyBaseUrl(cfg({ labGatewayUrl: "https://dev.gw/" }))).toBe("https://dev.gw/v1");
    expect(labProxyBaseUrl(cfg({ labGatewayUrl: "https://x/v1" }))).toBe("https://x/v1"); // 중복 안 붙임
  });
  it("native family baseUrl (gemini→google openai-compat, openai→openai)", () => {
    expect(nativeBaseUrl("gemini")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(nativeBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(nativeBaseUrl("ollama")).toBe("http://localhost:11434/v1");
    expect(nativeBaseUrl("gemini", "https://custom/")).toBe("https://custom");
  });
});

describe("calculateCost (가격표)", () => {
  it("gemini-2.5-flash 등록 모델 = 토큰×단가", () => {
    // input 0.3/1e6, output 2.5/1e6
    expect(calculateCost("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeCloseTo(0.3 + 2.5, 6);
  });
  it("미등록 모델 = 0 (크래시 아님)", () => {
    expect(calculateCost("unknown-model", 100, 100)).toBe(0);
  });
});

describe("makeProviderResolver (요청별 transport)", () => {
  // 첫 fetch 호출의 url+headers 포착(transport 도달 확인). 스트림은 즉시 done.
  function capture() {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const fetch = async (url: string, init: { headers: Record<string, string> }) => {
      box.url = url; box.headers = init.headers;
      return { ok: true, status: 200, statusText: "OK", body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
    };
    return { fetch, box };
  }

  it("lab-proxy: naiaKey+gemini → api.nextain.io + X-AnyLLM-Key", async () => {
    const { fetch, box } = capture();
    const r = makeProviderResolver({ fetch: fetch as never });
    await collect(r.resolve(cfg({ provider: "gemini", naiaKey: "naia-XYZ" })).chat(cfg({ naiaKey: "naia-XYZ" }), [], {}));
    expect(box.url).toBe("https://api.nextain.io/v1/chat/completions");
    expect(box.headers?.["X-AnyLLM-Key"]).toBe("naia-XYZ");
    expect(box.headers?.Authorization).toBeUndefined();
  });

  it("native: 키 직접(gemini, naiaKey 없음) → google openai-compat + Bearer apiKey", async () => {
    const { fetch, box } = capture();
    const r = makeProviderResolver({ fetch: fetch as never });
    await collect(r.resolve(cfg({ provider: "gemini", apiKey: "G-KEY" })).chat(cfg({ apiKey: "G-KEY" }), [], {}));
    expect(box.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(box.headers?.Authorization).toBe("Bearer G-KEY");
    expect(box.headers?.["X-AnyLLM-Key"]).toBeUndefined();
  });
});

describe("usage cost 방출 (크래시 회귀 방지 — formatCost(undefined))", () => {
  it("terminal usage 에 cost·model 실림 (fake usage 5/7, gemini-2.5-flash)", async () => {
    const emits: { e: AgentEmit }[] = [];
    const deps: HandlerDeps = {
      provider: makeFakeProvider(),
      conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: (_r, e) => emits.push({ e }) },
      diag: { log: () => {} },
    };
    const r: ChatRequest = { kind: "chat", requestId: "r1", provider: { provider: "gemini", model: "gemini-2.5-flash" }, messages: [{ role: "user", content: "hi" }] };
    await new ChatTurnHandler(deps).onChatRequest(r);
    const usage = emits.map((x) => x.e).find((e) => e.kind === "usage") as Extract<AgentEmit, { kind: "usage" }>;
    expect(usage).toBeDefined();
    expect(usage.model).toBe("gemini-2.5-flash");
    expect(typeof usage.cost).toBe("number");          // ⚠️ undefined 였으면 셸 formatCost 크래시
    expect(usage.cost).toBeCloseTo(calculateCost("gemini-2.5-flash", usage.inputTokens, usage.outputTokens), 9);
  });
});

describe("canonical 흐름 wire 관통 (config provider → resolver → transport → cost → wire)", () => {
  // SSE 스트림 mock(content + usage) — 실 네트워크 없이 openai-compat transport 구동.
  function sseFetch(box: { url?: string; headers?: Record<string, string> }) {
    const enc = new TextEncoder();
    const lines = [
      'data: {"choices":[{"delta":{"content":"안녕하세요"}}]}\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n',
      "data: [DONE]\n",
    ];
    return async (url: string, init: { headers: Record<string, string> }) => {
      box.url = url; box.headers = init.headers;
      let i = 0;
      const reader = { read: async () => (i < lines.length ? { done: false, value: enc.encode(lines[i++]) } : { done: true }), cancel() {} };
      return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
    };
  }
  function memIO() {
    const out: string[] = []; let cb: ((l: string) => void) | null = null;
    return { io: { writeLine: (l: string) => out.push(l), onLine: (c: (l: string) => void) => { cb = c; return () => { cb = null; }; } }, out, feed: (l: string) => cb?.(l) };
  }
  async function waitFor(cond: () => boolean) { for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); }

  it("config{gemini, naiaKey} → lab-proxy(api.nextain.io, X-AnyLLM-Key) → text→usage(cost)→finish wire", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    const { start } = wireAgentUC1({ io, resolver });
    start?.();
    feed(JSON.stringify({ type: "chat_request", requestId: "w1", provider: { provider: "gemini", model: "gemini-2.5-flash", naiaKey: "naia-XYZ" }, messages: [{ role: "user", content: "안녕" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "finish"));

    const msgs = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    // transport 도달: lab-proxy 라우팅(api.nextain.io + X-AnyLLM-Key)
    expect(box.url).toBe("https://api.nextain.io/v1/chat/completions");
    expect(box.headers?.["X-AnyLLM-Key"]).toBe("naia-XYZ");
    // wire 시퀀스 + usage 에 cost·model(셸 formatCost 크래시 회귀 방지)
    expect(msgs.map((m) => m["type"])).toEqual(["text", "usage", "finish"]);
    const usage = msgs.find((m) => m["type"] === "usage");
    expect(usage?.["model"]).toBe("gemini-2.5-flash");
    expect(typeof usage?.["cost"]).toBe("number");
    expect(usage?.["cost"]).toBeCloseTo(calculateCost("gemini-2.5-flash", 5, 7), 9);
    expect(msgs.every((m) => m["requestId"] === "w1")).toBe(true);
  });
});
