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
// stdio 는 production(composition)에서 제거(transport=gRPC) → 테스트는 stdio 어댑터 직접 사용(in-process wire 검증).
import { makeStdioIngress, makeStdioEgress } from "../main/adapters/stdio.js";
import type { ProviderConfig, AgentEmit, ChatRequest } from "../main/domain/chat.js";

const cfg = (over: Partial<ProviderConfig>): ProviderConfig => ({ provider: "gemini", model: "gemini-2.5-flash", ...over });

async function collect(stream: AsyncIterable<unknown>) { for await (const _ of stream) { /* drain */ } }

describe("provider-route (순수 라우팅)", () => {
  it("ollama → ollama (naiaKey 무관)", () => {
    expect(resolveProviderRoute(cfg({ provider: "ollama", naiaKey: "n" }))).toBe("ollama");
    expect(resolveProviderRoute(cfg({ provider: "ollama" }))).toBe("ollama");
  });
  it("nextain(naia 계정 타입) → lab-proxy", () => {
    expect(resolveProviderRoute(cfg({ provider: "nextain", naiaKey: "naia-123" }))).toBe("lab-proxy");
  });
  it("API-key 타입(gemini/zai/openai)은 naiaKey 있어도 native 직결 (provider 타입 기준, naiaKey 무관)", () => {
    expect(resolveProviderRoute(cfg({ provider: "gemini", naiaKey: "naia-123" }))).toBe("native");
    expect(resolveProviderRoute(cfg({ provider: "zai", naiaKey: "naia-123" }))).toBe("native");
    expect(resolveProviderRoute(cfg({ provider: "gemini" }))).toBe("native");
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
    expect(nativeBaseUrl("zai")).toBe("https://api.z.ai/api/coding/paas/v4"); // z.ai coding(실측 200), bigmodel 아님
    expect(nativeBaseUrl("glm")).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(nativeBaseUrl("ollama")).toBe("http://localhost:11434/v1");
    expect(nativeBaseUrl("gemini", "https://custom/")).toBe("https://custom");
  });
  it("★ 미등록 provider(anthropic 등) override 없음 → 정직 에러(silent openai 오라우팅 금지, 리뷰 MEDIUM fix)", () => {
    expect(() => nativeBaseUrl("anthropic")).toThrow(); // openai 로 조용히 보내지 않음
    expect(() => nativeBaseUrl("unknown-xyz")).toThrow();
    expect(nativeBaseUrl("anthropic", "https://my-host/v1")).toBe("https://my-host/v1"); // override 는 허용(커스텀 compat)
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

  it("lab-proxy: nextain(naia 계정) → api.nextain.io/v1 + X-AnyLLM-Key Bearer", async () => {
    const { fetch, box } = capture();
    const r = makeProviderResolver({ fetch: fetch as never });
    const nx = cfg({ provider: "nextain", naiaKey: "naia-XYZ" });
    await collect(r.resolve(nx).chat(nx, [], {}));
    expect(box.url).toBe("https://api.nextain.io/v1/chat/completions");
    expect(box.headers?.["X-AnyLLM-Key"]).toBe("Bearer naia-XYZ");
    expect(box.headers?.Authorization).toBeUndefined();
  });
  it("native: zai(glm, API-key) → z.ai coding + Bearer apiKey (게이트웨이 안 탐)", async () => {
    const { fetch, box } = capture();
    const r = makeProviderResolver({ fetch: fetch as never });
    const z = cfg({ provider: "zai", model: "glm-5.1", apiKey: "GLM-KEY" });
    await collect(r.resolve(z).chat(z, [], {}));
    expect(box.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(box.headers?.Authorization).toBe("Bearer GLM-KEY");
    expect(box.headers?.["X-AnyLLM-Key"]).toBeUndefined();
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

  it("config{nextain, naiaKey} → lab-proxy(api.nextain.io/v1, X-AnyLLM-Key Bearer) → text→usage(cost)→finish wire", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    const { start } = wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), resolver });
    start?.();
    feed(JSON.stringify({ type: "chat_request", requestId: "w1", provider: { provider: "nextain", model: "gemini-2.5-flash", naiaKey: "naia-XYZ" }, messages: [{ role: "user", content: "안녕" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "finish"));

    const msgs = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    // transport 도달: nextain(naia 계정) → lab-proxy 라우팅(api.nextain.io/v1 + X-AnyLLM-Key Bearer)
    expect(box.url).toBe("https://api.nextain.io/v1/chat/completions");
    expect(box.headers?.["X-AnyLLM-Key"]).toBe("Bearer naia-XYZ");
    // wire 시퀀스 + usage 에 cost·model(셸 formatCost 크래시 회귀 방지)
    expect(msgs.map((m) => m["type"])).toEqual(["text", "usage", "finish"]);
    const usage = msgs.find((m) => m["type"] === "usage");
    expect(usage?.["model"]).toBe("gemini-2.5-flash");
    expect(typeof usage?.["cost"]).toBe("number");
    expect(usage?.["cost"]).toBeCloseTo(calculateCost("gemini-2.5-flash", 5, 7), 9);
    expect(msgs.every((m) => m["requestId"] === "w1")).toBe(true);
  });
});

describe("config 정본 fallback (정본: 대화는 메시지만 — wire provider 없으면 기동 defaultConfig 사용)", () => {
  function sseFetch(box: { url?: string; headers?: Record<string, string> }) {
    const enc = new TextEncoder();
    const lines = ['data: {"choices":[{"delta":{"content":"안녕"}}]}\n', 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n', "data: [DONE]\n"];
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

  it("chat_request 에 provider 없음 + defaultConfig{glm} → defaultConfig 로 native z.ai 직결(wire 아님)", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    // 기동 시 naia-settings 로딩한 활성 provider 를 주입(라이브 entry 의 settingsStore.loadMain 결과).
    const { start } = wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), resolver, defaultConfig: { provider: "zai", model: "glm-5.1", apiKey: "GLM-KEY" } });
    start?.();
    // ⚠️ provider 필드 없는 chat_request — agent 가 defaultConfig 를 써야만 통과.
    feed(JSON.stringify({ type: "chat_request", requestId: "d1", messages: [{ role: "user", content: "안녕" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "finish"));
    expect(box.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(box.headers?.Authorization).toBe("Bearer GLM-KEY");
    const msgs = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(msgs.map((m) => m["type"])).toEqual(["text", "usage", "finish"]);
    expect(msgs.find((m) => m["type"] === "usage")?.["model"]).toBe("glm-5.1"); // cost 도 defaultConfig.model 기준
  });

  it("wire provider 있으면 그 요청만 오버라이드(하위호환) — defaultConfig{glm} 무시하고 nextain 으로", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    const { start } = wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), resolver, defaultConfig: { provider: "zai", model: "glm-5.1", apiKey: "GLM-KEY" } });
    start?.();
    feed(JSON.stringify({ type: "chat_request", requestId: "d2", provider: { provider: "nextain", model: "gemini-2.5-flash", naiaKey: "naia-XYZ" }, messages: [{ role: "user", content: "안녕" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "finish"));
    expect(box.url).toBe("https://api.nextain.io/v1/chat/completions"); // wire override = lab-proxy(naia 계정)
    expect(box.headers?.["X-AnyLLM-Key"]).toBe("Bearer naia-XYZ");
  });

  it("standalone tool_request(old-core 스킬) → 같은 requestId 즉시 error(셸 120s 행 방지, 네트워크 0)", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    const { start } = wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), resolver, defaultConfig: { provider: "zai", model: "glm-5.1", apiKey: "K" } });
    start?.();
    feed(JSON.stringify({ type: "tool_request", requestId: "tr1", toolName: "skill_sessions", args: { action: "reset" } }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "error"));
    const err = out.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m["type"] === "error");
    expect(err?.["requestId"]).toBe("tr1"); // 셸 directToolCall 이 requestId 매칭 → reject→catch(warn)
    expect(String(err?.["message"])).toMatch(/skill_sessions|미지원/);
    expect(box.url).toBeUndefined(); // chat 아님 — 네트워크 0
  });

  it("provider 도 defaultConfig 도 없음 → honest error(no provider configured)", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    const { start } = wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), resolver }); // defaultConfig 없음
    start?.();
    feed(JSON.stringify({ type: "chat_request", requestId: "d3", messages: [{ role: "user", content: "안녕" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "error"));
    const err = out.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m["type"] === "error");
    expect(String(err?.["message"])).toMatch(/no provider configured/);
    expect(box.url).toBeUndefined(); // 네트워크 호출 0
  });
});
