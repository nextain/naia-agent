// UC-THINKING 계약 테스트 — 추론(thinking) 모델의 생각 출력 제어. mock fetch(요청 body 포착), 실 API 없이.
//
// 왜 이 UC 가 있는가(실측 2026-07-14, ollama 0.32.0 / Qwen3.5-9B 계열 / 도구 9개):
//   thinking on  → 6회 중 2회 **빈 답변**(본문 0자), 1회 지식과 다른 시각을 지어냄.
//   thinking off → 6회 중 0회. 완성 토큰 115→17~34, 응답 2.2s→0.75s.
//   빈 응답의 finish_reason 은 length(잘림)가 **아니라 stop** — 컨텍스트를 16k 로 키워도 재현된다.
//   OpenAI-compat wire 에서 실제로 듣는 스위치는 `reasoning_effort:"none"` 하나뿐이었다.
//
// 회귀 방지의 핵심(FR-THINK-2): naia-os 셸은 `enableThinking:false` 를 **기본값으로 항상 전송**한다.
//   게이트가 없으면 gpt-4o·Gemini·GLM 같은 **비추론 원격 모델**에 reasoning_effort 가 실려 400 이 난다.
import { describe, it, expect } from "vitest";
import { makeOpenAICompatProvider } from "../main/adapters/openai-compat-provider.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { isLocalEngineBaseUrl } from "../main/domain/provider-route.js";
import { parseChatArgs } from "../main/app/cli-chat.js";
import {
  type ProviderChunk,
  type ProviderConfig,
  type ChatRequest,
  type ChatMessage,
  type AgentEmit,
  resolveTurnThinking,
  threadToolRound,
} from "../main/domain/chat.js";
import { chatRequestToDomain } from "../main/adapters/grpc/grpc-codec.js";
import { decodeRequest } from "../main/adapters/protocol.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";

/** 요청 body 를 포착하는 mock fetch(SSE 1줄 + DONE). */
function captureFetch(sink: { body?: Record<string, unknown> }) {
  const enc = new TextEncoder();
  const lines = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];
  return async (_url: string, init: { body: string }) => {
    sink.body = JSON.parse(init.body) as Record<string, unknown>;
    let i = 0;
    const reader = {
      async read() { return i >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[i++]!) }; },
      async cancel() {},
    };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
  };
}
async function drain(g: AsyncIterable<ProviderChunk>) { for await (const _ of g) { /* consume */ } }

/** 한 번 호출하고 그때 나간 요청 body 를 돌려준다. */
async function bodyOf(o: { supportsReasoningEffort?: boolean; enableThinking?: boolean }) {
  const sink: { body?: Record<string, unknown> } = {};
  const prov = makeOpenAICompatProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "test",
    ...(o.supportsReasoningEffort !== undefined ? { supportsReasoningEffort: o.supportsReasoningEffort } : {}),
    fetch: captureFetch(sink) as never,
  });
  const cfg: ProviderConfig = {
    provider: "openai-compat",
    model: "qwen3.5:9b",
    ...(o.enableThinking !== undefined ? { enableThinking: o.enableThinking } : {}),
  };
  await drain(prov.chat(cfg, [{ role: "user", content: "hi" }], {}));
  return sink.body!;
}

describe("UC-THINKING — S-THINK-1 (도메인 의도 → wire 반영)", () => {
  it("FR-THINK-1: 로컬 엔진 + enableThinking=false → reasoning_effort:'none' 을 싣는다", async () => {
    const body = await bodyOf({ supportsReasoningEffort: true, enableThinking: false });
    expect(body.reasoning_effort).toBe("none");
  });

  it("FR-THINK-1: enableThinking=true → 아무 것도 싣지 않는다(추론 모델 기본=생각 켬)", async () => {
    const body = await bodyOf({ supportsReasoningEffort: true, enableThinking: true });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("FR-THINK-1: enableThinking 미지정 → 아무 것도 싣지 않는다(무회귀)", async () => {
    const body = await bodyOf({ supportsReasoningEffort: true });
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("UC-THINKING — S-THINK-2 (로컬 엔진 게이트 = 400 회귀 방지)", () => {
  it("FR-THINK-2: supportsReasoningEffort=false 면 enableThinking=false 여도 싣지 않는다", async () => {
    const body = await bodyOf({ supportsReasoningEffort: false, enableThinking: false });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("FR-THINK-2: supportsReasoningEffort 미주입(기본) = 보수적으로 미전송", async () => {
    const body = await bodyOf({ enableThinking: false });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("FR-THINK-4: 기존 body 필드는 그대로(무회귀)", async () => {
    const body = await bodyOf({ supportsReasoningEffort: true, enableThinking: false });
    expect(body.model).toBe("qwen3.5:9b");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("UC-THINKING — isLocalEngineBaseUrl (순수 판별)", () => {
  it("로컬(loopback/사설망) = true", () => {
    for (const u of [
      "http://127.0.0.1:11434/v1",   // ollama 기본
      "http://localhost:11434/v1",
      "http://localhost:8000/v1",    // vLLM 기본
      "http://192.168.0.10:11434/v1",
      "http://10.1.2.3:8000/v1",
      "http://172.16.5.9:8000/v1",
      "http://172.31.0.1:8000/v1",
      "http://naia-box.local:11434/v1",
      "http://mybox.tailabc123.ts.net:11435/v1", // Tailscale MagicDNS(#118)
      "http://100.64.0.1:8000/v1",               // CGNAT 하한 경계(#118)
      "http://100.127.255.254:8000/v1",          // CGNAT 상한 경계(#118)
    ]) expect(isLocalEngineBaseUrl(u), u).toBe(true);
  });

  it("원격(공인) = false — 여기에 reasoning_effort 를 보내면 400", () => {
    for (const u of [
      "https://api.openai.com/v1",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "https://api.z.ai/api/coding/paas/v4",
      "https://api.x.ai/v1",
      "https://api.nextain.io/v1",     // lab-proxy 게이트웨이
      "http://172.32.0.1:8000/v1",     // 172.32 = 사설망 아님(경계)
      "http://11.0.0.1:8000/v1",       // 11.x = 사설망 아님(경계)
      "http://100.63.255.255:8000/v1", // CGNAT 직전 = 공인(경계, #118)
      "http://100.128.0.1:8000/v1",    // CGNAT 직후 = 공인(경계, #118)
      "not-a-url",                     // 파싱 불가 = 보수적으로 false
    ]) expect(isLocalEngineBaseUrl(u), u).toBe(false);
  });
});

describe("UC-THINKING — CLI 표면 (--no-think/--think)", () => {
  // 왜: 이 플래그가 없으면 레포의 자체 검증 도구(CLI)로 본 결함을 **재현·검증할 수 없다**.
  //     셸은 gRPC 로 enableThinking 을 보내지만 CLI 엔 표면이 없었다.
  /** parseChatArgs 성공을 단언하고 args 를 좁혀 돌려준다(실패면 즉시 테스트 실패). */
  const argsOf = (argv: string[]) => {
    const r = parseChatArgs(argv);
    if (!r.ok || !r.args) throw new Error(`parseChatArgs 실패: ${r.error ?? "args 없음"}`);
    return r.args;
  };

  it("--no-think → enableThinking=false", () => {
    expect(argsOf(["--no-think"]).enableThinking).toBe(false);
  });

  it("--think → enableThinking=true", () => {
    expect(argsOf(["--think"]).enableThinking).toBe(true);
  });

  it("미지정 → 필드 자체가 없다(모델 기본 유지, 무회귀)", () => {
    expect("enableThinking" in argsOf(["--once", "hi"])).toBe(false);
  });
});

describe("UC-THINKING — S-THINK-3 / FR-THINK-3 (resolver 가 판단해 주입)", () => {
  it("로컬 ollama host(native 라우트) → reasoning_effort 가 실린다", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const resolver = makeProviderResolver({ fetch: captureFetch(sink) as never });
    // provider 미등록 → native 라우트 → nativeBaseUrl 의 override 경로(labGatewayUrl)
    const cfg: ProviderConfig = {
      provider: "openai-compat",
      model: "qwen3.5:9b",
      labGatewayUrl: "http://127.0.0.1:11434/v1",
      enableThinking: false,
    };
    await drain(resolver.resolve(cfg).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!.reasoning_effort).toBe("none");
  });

  it("원격 openai(native 라우트) → enableThinking=false 여도 실리지 않는다 (400 회귀 방지)", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const resolver = makeProviderResolver({ fetch: captureFetch(sink) as never });
    const cfg: ProviderConfig = { provider: "openai", model: "gpt-4o", enableThinking: false };
    await drain(resolver.resolve(cfg).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!).not.toHaveProperty("reasoning_effort");
  });

  it("lab-proxy 게이트웨이 → 실리지 않는다 (뒤에 어떤 모델이 있을지 모름)", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const resolver = makeProviderResolver({ fetch: captureFetch(sink) as never });
    const cfg: ProviderConfig = { provider: "nextain", model: "auto", naiaKey: "k", enableThinking: false };
    await drain(resolver.resolve(cfg).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!).not.toHaveProperty("reasoning_effort");
  });
});

describe("UC-THINKING — S-THINK-6 / FR-THINK-7·8 (도메인 & 디코드)", () => {
  it("FR-THINK-8: resolveTurnThinking(req) — 턴 세기 유일 결정 지점", () => {
    expect(resolveTurnThinking({ kind: "chat", requestId: "r", messages: [], thinking: { level: "low" } })).toBe("low");
    expect(resolveTurnThinking({ kind: "chat", requestId: "r", messages: [], thinking: { level: "high" } })).toBe("high");
    expect(resolveTurnThinking({ kind: "chat", requestId: "r", messages: [], thinking: { level: "off" } })).toBe("off");
    expect(resolveTurnThinking({ kind: "chat", requestId: "r", messages: [] })).toBeUndefined();
    expect(resolveTurnThinking({ kind: "chat", requestId: "r", messages: [], enableThinking: true })).toBeUndefined();
  });

  it("FR-THINK-10: threadToolRound 5번째 인자(roundThinking) — 비어있지 않을 때만 assistant.reasoningContent 설정", () => {
    const r1 = threadToolRound([], "text", [{ id: "c1", name: "t1", args: {} }], [{ output: "out" }], "pondering deep");
    expect(r1[0]).toMatchObject({ role: "assistant", content: "text", reasoningContent: "pondering deep" });

    const r2 = threadToolRound([], "text", [{ id: "c1", name: "t1", args: {} }], [{ output: "out" }], "");
    expect(r2[0]).not.toHaveProperty("reasoningContent");

    const r3 = threadToolRound([], "text", [{ id: "c1", name: "t1", args: {} }], [{ output: "out" }]);
    expect(r3[0]).not.toHaveProperty("reasoningContent");
  });

  it("FR-THINK-7: gRPC 디코드(chatRequestToDomain) — thinking 부재 / UNSPECIFIED / OFF / LOW / HIGH (숫자 및 문자열)", () => {
    // 부재
    expect(chatRequestToDomain({ requestId: "r1", messages: [] }).thinking).toBeUndefined();

    // 0 / UNSPECIFIED
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: 0 } }).thinking).toBeUndefined();
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: "THINKING_LEVEL_UNSPECIFIED" } }).thinking).toBeUndefined();

    // 1 / OFF
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: 1 } }).thinking).toEqual({ level: "off" });
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: "THINKING_LEVEL_OFF" } }).thinking).toEqual({ level: "off" });

    // 2 / LOW
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: 2 } }).thinking).toEqual({ level: "low" });
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: "THINKING_LEVEL_LOW" } }).thinking).toEqual({ level: "low" });

    // 3 / HIGH
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: 3 } }).thinking).toEqual({ level: "high" });
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: "THINKING_LEVEL_HIGH" } }).thinking).toEqual({ level: "high" });

    // 그 밖의 값 → 부재
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: 99 } }).thinking).toBeUndefined();
    expect(chatRequestToDomain({ requestId: "r1", messages: [], thinking: { level: "OTHER" } }).thinking).toBeUndefined();
  });

  it("FR-THINK-7: stdio protocol 디코드(decodeRequest) — thinking: {level} 수용", () => {
    const dOff = decodeRequest(JSON.stringify({ type: "chat_request", requestId: "r1", messages: [], thinking: { level: "off" } })) as ChatRequest;
    expect(dOff.thinking).toEqual({ level: "off" });

    const dLow = decodeRequest(JSON.stringify({ type: "chat_request", requestId: "r1", messages: [], thinking: { level: "low" } })) as ChatRequest;
    expect(dLow.thinking).toEqual({ level: "low" });

    const dHigh = decodeRequest(JSON.stringify({ type: "chat_request", requestId: "r1", messages: [], thinking: { level: "high" } })) as ChatRequest;
    expect(dHigh.thinking).toEqual({ level: "high" });

    const dInvalid = decodeRequest(JSON.stringify({ type: "chat_request", requestId: "r1", messages: [], thinking: { level: "medium" } })) as ChatRequest;
    expect(dInvalid.thinking).toBeUndefined();

    const dNone = decodeRequest(JSON.stringify({ type: "chat_request", requestId: "r1", messages: [] })) as ChatRequest;
    expect(dNone.thinking).toBeUndefined();
  });

  it("CLI 표면 --think=low|high|off 파싱", () => {
    const parse = (argv: string[]) => {
      const r = parseChatArgs(argv);
      if (!r.ok || !r.args) throw new Error(r.error);
      return r.args;
    };
    expect(parse(["--think=low"])).toMatchObject({ enableThinking: true, thinking: { level: "low" } });
    expect(parse(["--think=high"])).toMatchObject({ enableThinking: true, thinking: { level: "high" } });
    expect(parse(["--think=off"])).toMatchObject({ enableThinking: false, thinking: { level: "off" } });
    expect(parseChatArgs(["--think=invalid"]).ok).toBe(false);
  });
});

describe("UC-THINKING — S-THINK-7 / FR-THINK-9 (게이트웨이/로컬/원격 reasoning_effort 본문 제어)", () => {
  it("게이트웨이(nextain) 경로 — low/high 면 reasoning_effort 실림, off/미지정은 키 자체가 없음", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const resolver = makeProviderResolver({ fetch: captureFetch(sink) as never });

    // low
    const cfgLow: ProviderConfig = { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k", thinkingLevel: "low" };
    await drain(resolver.resolve(cfgLow).chat(cfgLow, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!.reasoning_effort).toBe("low");

    // high
    const cfgHigh: ProviderConfig = { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k", thinkingLevel: "high" };
    await drain(resolver.resolve(cfgHigh).chat(cfgHigh, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!.reasoning_effort).toBe("high");

    // off — 키 자체가 없어야 함(무전송)
    const cfgOff: ProviderConfig = { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k", thinkingLevel: "off" };
    await drain(resolver.resolve(cfgOff).chat(cfgOff, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!).not.toHaveProperty("reasoning_effort");

    // 미지정 — 키 자체가 없어야 함(무전송)
    const cfgUnspec: ProviderConfig = { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k" };
    await drain(resolver.resolve(cfgUnspec).chat(cfgUnspec, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!).not.toHaveProperty("reasoning_effort");
  });

  it("로컬 엔진 경로 off → reasoning_effort:'none' 동작 무변경 유지", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const resolver = makeProviderResolver({ fetch: captureFetch(sink) as never });
    const cfg: ProviderConfig = {
      provider: "openai-compat",
      model: "qwen3.5:9b",
      labGatewayUrl: "http://127.0.0.1:11434/v1",
      enableThinking: false,
    };
    await drain(resolver.resolve(cfg).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!.reasoning_effort).toBe("none");
  });

  it("원격(비게이트웨이) 경로 low → reasoning_effort 키 없음 (400 방지)", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const resolver = makeProviderResolver({ fetch: captureFetch(sink) as never });
    const cfg: ProviderConfig = { provider: "openai", model: "gpt-4o", thinkingLevel: "low" };
    await drain(resolver.resolve(cfg).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(sink.body!).not.toHaveProperty("reasoning_effort");
  });
});

describe("UC-THINKING — S-THINK-8 / FR-THINK-10 (도구 루프 에코 및 wire 메시지)", () => {
  it("toWireMessages 에코 — echoReasoningContent=true 이고 thinking 이 비어있지 않을 때만 reasoning_content 포함", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    const provEcho = makeOpenAICompatProvider({
      baseUrl: "https://api.nextain.io/v1",
      apiKey: "k",
      echoReasoningContent: true,
      fetch: captureFetch(sink) as never,
    });

    const messagesWithReasoning: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "t1", args: {} }],
        reasoningContent: "I am thinking about t1",
      },
      { role: "tool", toolCallId: "c1", content: "result 1" },
    ];

    const cfg: ProviderConfig = { provider: "nextain", model: "deepseek-v4-flash" };
    await drain(provEcho.chat(cfg, messagesWithReasoning, {}));
    const wireMsgs = sink.body!.messages as Array<Record<string, unknown>>;
    expect(wireMsgs[1].reasoning_content).toBe("I am thinking about t1");

    // 빈 생각인 경우 → reasoning_content 키 없음
    const messagesWithEmptyReasoning: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "t1", args: {} }],
        reasoningContent: "",
      },
      { role: "tool", toolCallId: "c1", content: "result 1" },
    ];
    await drain(provEcho.chat(cfg, messagesWithEmptyReasoning, {}));
    const wireMsgsEmpty = sink.body!.messages as Array<Record<string, unknown>>;
    expect(wireMsgsEmpty[1]).not.toHaveProperty("reasoning_content");

    // echoReasoningContent=false 인 경우 → reasoning_content 키 없음
    const provNoEcho = makeOpenAICompatProvider({
      baseUrl: "https://api.nextain.io/v1",
      apiKey: "k",
      echoReasoningContent: false,
      fetch: captureFetch(sink) as never,
    });
    await drain(provNoEcho.chat(cfg, messagesWithReasoning, {}));
    const wireMsgsNoEcho = sink.body!.messages as Array<Record<string, unknown>>;
    expect(wireMsgsNoEcho[1]).not.toHaveProperty("reasoning_content");
  });
});

describe("UC-THINKING — S-THINK-9 / FR-THINK-11 (응답 다중 형식 & 중복 방지)", () => {
  function sseFetch(lines: string[]) {
    const enc = new TextEncoder();
    return async () => {
      let i = 0;
      const reader = {
        async read() { return i >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[i++]!) }; },
        async cancel() {},
      };
      return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
    };
  }

  async function collect(g: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
    const out: ProviderChunk[] = [];
    for await (const c of g) out.push(c);
    return out;
  }

  it("delta.reasoning.content 파싱 수용", async () => {
    const fetch = sseFetch([
      'data: {"choices":[{"delta":{"reasoning":{"content":"nested thought"}}}]}\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
      'data: [DONE]\n',
    ]);
    const prov = makeOpenAICompatProvider({ baseUrl: "https://api.nextain.io/v1", apiKey: "k", fetch: fetch as never });
    const chunks = await collect(prov.chat({ provider: "nextain", model: "deepseek-v4-flash" }, [{ role: "user", content: "hi" }], {}));
    expect(chunks.find((c) => c.kind === "thinking")).toEqual({ kind: "thinking", text: "nested thought" });
  });

  it("delta.reasoning_content 와 delta.reasoning.content 동시 존재 시 reasoning_content 만 채택 (중복 없음)", async () => {
    const fetch = sseFetch([
      'data: {"choices":[{"delta":{"reasoning_content":"direct thought","reasoning":{"content":"nested thought"}}}]}\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
      'data: [DONE]\n',
    ]);
    const prov = makeOpenAICompatProvider({ baseUrl: "https://api.nextain.io/v1", apiKey: "k", fetch: fetch as never });
    const chunks = await collect(prov.chat({ provider: "nextain", model: "deepseek-v4-flash" }, [{ role: "user", content: "hi" }], {}));
    const thinkingChunks = chunks.filter((c) => c.kind === "thinking");
    expect(thinkingChunks).toEqual([{ kind: "thinking", text: "direct thought" }]);
  });
});

describe("UC-THINKING — Ollama capability status handoff", () => {
  it("turn level survives into ProviderConfig and the explicit unsupported signal uses the existing AgentEmit path", async () => {
    const emits: { requestId: string; e: AgentEmit }[] = [];
    let seenConfig: ProviderConfig | undefined;
    const provider: ProviderPort = {
      async *chat(config: ProviderConfig, _messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        seenConfig = config;
        opts.onOllamaThinkingUnsupported?.(config.ollamaHost ?? "http://localhost:11434", config.model);
        yield { kind: "finish" };
      },
    };
    const deps: HandlerDeps = {
      provider: makeFakeProvider(),
      resolver: { resolve: () => provider },
      conversation: { assemble: (request) => ({ messages: request.messages }) },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: (requestId, e) => emits.push({ requestId, e }) },
      diag: { log: () => {} },
    };
    await new ChatTurnHandler(deps).onChatRequest({
      kind: "chat",
      requestId: "ollama-thinking-status",
      provider: { provider: "ollama", model: "qwen3:8b", ollamaHost: "http://localhost:11434" },
      thinking: { level: "high" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seenConfig).toMatchObject({ thinkingLevel: "high", enableThinking: true });
    expect(emits.map(({ e }) => e.kind)).toContain("logEntry");
    expect(emits.find(({ e }) => e.kind === "logEntry")?.e).toEqual({
      kind: "logEntry",
      level: "ollama_thinking_unsupported",
      message: JSON.stringify({ host: "http://localhost:11434", model: "qwen3:8b" }),
    });
  });

  it("keeps Ollama capability probing and think conversion out of other providers", async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const enc = new TextEncoder();
    const fetch = async (url: string, init: { body: string }) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      let index = 0;
      const lines = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n"];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: { getReader: () => ({ async read() { return index >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[index++]!) }; } }) },
      };
    };
    const resolver = makeProviderResolver({ fetch: fetch as never });
    const config: ProviderConfig = { provider: "openai", model: "gpt-4o", thinkingLevel: "high", enableThinking: true };
    await drain(resolver.resolve(config).chat(config, [{ role: "user", content: "hi" }], {}));
    expect(urls.some((url) => url.endsWith("/api/show"))).toBe(false);
    expect(bodies[0]).not.toHaveProperty("think");
  });
});

describe("UC-THINKING — 핸들러 2라운드 도구 루프 통합 (첫 라운드 생각이 두 번째 요청 본문에 reasoning_content 로 실림)", () => {
  it("두 번째 요청 본문의 assistant 메시지에 reasoning_content 가 실린다", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const enc = new TextEncoder();
    let roundIndex = 0;

    const mockFetch = async (_url: string, init: { body: string }) => {
      capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      roundIndex++;
      const lines = roundIndex === 1
        ? [
            'data: {"choices":[{"delta":{"reasoning_content":"thinking in round 1","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}]}}]}\n',
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
            'data: [DONE]\n',
          ]
        : [
            'data: {"choices":[{"delta":{"content":"The time is 12:00."}}]}\n',
            'data: {"choices":[{"finish_reason":"stop"}]}\n',
            'data: [DONE]\n',
          ];
      let i = 0;
      const reader = {
        async read() { return i >= lines.length ? { done: true } : { done: false, value: enc.encode(lines[i++]!) }; },
        async cancel() {},
      };
      return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
    };

    const resolver = makeProviderResolver({ fetch: mockFetch as never });
    const emits: { requestId: string; e: AgentEmit }[] = [];
    const toolExecutor = {
      specs: () => [{ name: "get_time", description: "time", parameters: { type: "object" }, tier: "none" }],
      async execute(call: { id: string; name: string; args: unknown }) {
        expect(call.name).toBe("get_time");
        return { output: "12:00" };
      },
    };

    const deps: HandlerDeps = {
      provider: makeFakeProvider(),
      resolver,
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      toolExecutor,
      egress: { emit: (requestId, e) => emits.push({ requestId, e }) },
      diag: { log: () => {} },
    };

    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-loop-1",
      provider: { provider: "nextain", model: "deepseek-v4-flash", naiaKey: "k" },
      thinking: { level: "low" },
      messages: [{ role: "user", content: "what time is it?" }],
    });

    expect(capturedBodies.length).toBe(2);
    // 첫 라운드: reasoning_effort: low
    expect(capturedBodies[0].reasoning_effort).toBe("low");

    // 두 번째 라운드: assistant 메시지에 reasoning_content 가 실림
    const round2Messages = capturedBodies[1].messages as Array<Record<string, unknown>>;
    expect(round2Messages.length).toBe(3);
    expect(round2Messages[0]).toEqual({ role: "user", content: "what time is it?" });
    expect(round2Messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "thinking in round 1",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } }],
    });
    expect(round2Messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "12:00",
    });

    // 턴 완료 확인
    expect(emits.at(-1)?.e.kind).toBe("finish");
  });
});


describe("FR-THINK-13·14 small model transport", () => {
  it("UT-SM-AGENT-THINK-01 proto 숫자와 이름의 네 수준을 디코드한다", () => {
    for (const [number, name, expected] of [[1, "OFF", "off"], [2, "LOW", "low"], [3, "HIGH", "high"], [4, "XHIGH", "xhigh"]] as const) {
      for (const level of [number, `THINKING_LEVEL_${name}`]) {
        expect(chatRequestToDomain({ requestId: "r", messages: [], thinking: { level } }).thinking).toEqual({ level: expected });
      }
    }
    for (const level of [0, "THINKING_LEVEL_UNSPECIFIED", 99, "UNKNOWN", undefined]) {
      expect(chatRequestToDomain({ requestId: "r", messages: [], thinking: { level } }).thinking).toBeUndefined();
    }
    for (const level of [undefined, 99, "UNKNOWN"] as const) for (const enabled of [true, false, undefined]) {
      const req = chatRequestToDomain({ requestId: "r", messages: [], ...(level === undefined ? {} : { thinking: { level } }), ...(enabled === undefined ? {} : { enableThinking: enabled }) });
      expect(resolveTurnThinking(req)).toBeUndefined();
      expect(req.enableThinking).toBe(enabled);
      expect("enableThinking" in req).toBe(enabled !== undefined);
    }
  });

  it("IT-SM-AGENT-THINK-01 요청 수준을 제공자별 계약대로 보낸다", async () => {
    for (const level of ["off", "low", "high", "xhigh"] as const) {
      const sink: { body?: Record<string, unknown> } = {};
      const provider = makeOpenAICompatProvider({ baseUrl: "https://example.invalid", apiKey: "test", supportsThinkingLevel: true, fetch: captureFetch(sink) as never });
      await drain(provider.chat({ provider: "nextain", model: "m", thinkingLevel: level, enableThinking: level !== "off" }, [], {}));
      if (level === "off") expect(sink.body).not.toHaveProperty("reasoning_effort");
      else expect(sink.body?.reasoning_effort).toBe(level);
    }
    for (const level of [undefined, 0, 99, "UNKNOWN"] as const) for (const enabled of [true, false, undefined]) {
      const req = chatRequestToDomain({ requestId: "r", messages: [], ...(level === undefined ? {} : { thinking: { level } }), ...(enabled === undefined ? {} : { enableThinking: enabled }) });
      for (const route of ["gateway", "local", "remote"] as const) {
        const sink: { body?: Record<string, unknown> } = {};
        const provider = makeOpenAICompatProvider({ baseUrl: "https://example.invalid", apiKey: "test", supportsThinkingLevel: route === "gateway", supportsReasoningEffort: route === "local", fetch: captureFetch(sink) as never });
        await drain(provider.chat({ provider: "test", model: "m", ...(req.enableThinking === undefined ? {} : { enableThinking: req.enableThinking }) }, [], {}));
        if (route === "local" && enabled === false) expect(sink.body?.reasoning_effort).toBe("none");
        else expect(sink.body).not.toHaveProperty("reasoning_effort");
      }
    }
  });
});

it("IT-SM-AGENT-THINK-01 Anthropic legacy 여섯 조합을 adaptive 본문으로 보존한다", async () => {
  const { makeAnthropicProvider } = await import("../main/adapters/anthropic-provider.js");
  for (const level of [undefined, 0, 99, "UNKNOWN"] as const) for (const enabled of [true, false, undefined]) {
    const request = chatRequestToDomain({ requestId: "r", messages: [], ...(level === undefined ? {} : { thinking: { level } }), ...(enabled === undefined ? {} : { enableThinking: enabled }) });
    const sink: { body?: Record<string, unknown> } = {};
    const provider = makeAnthropicProvider({ baseUrl: "https://example.invalid", apiKey: "fake", fetch: captureFetch(sink) as never });
    await drain(provider.chat({ provider: "anthropic", model: "m", ...(request.enableThinking === undefined ? {} : { enableThinking: request.enableThinking }) }, [], {}));
    if (enabled === true) expect(sink.body?.thinking).toEqual({ type: "adaptive" });
    else expect(sink.body).not.toHaveProperty("thinking");
  }
});

it("IT-SM-AGENT-THINK-01 미지정은 기존 provider 설정을 덮지 않는다", async () => {
  for (const raw of [undefined, 0, 99, "UNKNOWN"] as const) {
    let seen: ProviderConfig | undefined;
    const provider: ProviderPort = { async *chat(config) { seen = config; yield { kind: "finish" }; } };
    const handler = new ChatTurnHandler({ provider, defaultConfig: { provider: "nextain", model: "m", thinkingLevel: "xhigh", enableThinking: true }, conversation: { assemble: (request) => ({ messages: request.messages }) }, credentials: makeInMemoryCredentials(), approval: makeInMemoryApproval(), egress: { emit: () => {} }, diag: { log: () => {} } });
    const request = chatRequestToDomain({ requestId: "r", messages: [{ role: "user", content: "hi" }], ...(raw === undefined ? {} : { thinking: { level: raw } }) });
    await handler.onChatRequest(request);
    expect(seen).toMatchObject({ thinkingLevel: "xhigh", enableThinking: true });
    const sink: { body?: Record<string, unknown> } = {};
    const gateway = makeOpenAICompatProvider({ baseUrl: "https://example.invalid", apiKey: "fake", supportsThinkingLevel: true, fetch: captureFetch(sink) as never });
    await drain(gateway.chat(seen!, [], {})); expect(sink.body?.reasoning_effort).toBe("xhigh");
  }
});

it("IT-SM-AGENT-THINK-01 미지정은 Anthropic 기존 생각 설정을 유지한다", async () => {
  const { makeAnthropicProvider } = await import("../main/adapters/anthropic-provider.js");
  const sink: { body?: Record<string, unknown> } = {};
  const provider = makeAnthropicProvider({ baseUrl: "https://example.invalid", apiKey: "fake", fetch: captureFetch(sink) as never });
  await drain(provider.chat({ provider: "anthropic", model: "m", enableThinking: true }, [], {}));
  expect(sink.body?.thinking).toEqual({ type: "adaptive" });
});

it("IT-SM-AGENT-THINK-01 legacy 설정이 기존 수준보다 우선해 실제 제공자 본문에 반영된다", async () => {
  const { makeOllamaProvider } = await import("../main/adapters/ollama-provider.js");
  for (const raw of [undefined, 0, 99, "UNKNOWN"] as const) for (const enabled of [false, true, undefined]) {
    for (const route of ["gateway", "ollama"] as const) {
      const bodies: Record<string, unknown>[] = [];
      const gatewayFetch = captureFetch({});
      const fetch = async (url: string, init: { body: string }) => {
        if (url.endsWith("/api/show")) return { ok: true, status: 200, json: async () => ({ thinking: { values: [true, false] } }) };
        bodies.push(JSON.parse(init.body));
        if (route === "gateway") return gatewayFetch(url, init);
        const enc = new TextEncoder(); let done = false;
        return { ok: true, status: 200, statusText: "OK", body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: enc.encode('{"done":true}\n') }), cancel: async () => {} }) } };
      };
      const provider = route === "gateway" ? makeOpenAICompatProvider({ baseUrl: "https://example.invalid", apiKey: "fake", supportsThinkingLevel: true, fetch: fetch as never }) : makeOllamaProvider({ fetch: fetch as never });
      const handler = new ChatTurnHandler({ provider, defaultConfig: { provider: route === "gateway" ? "nextain" : "ollama", model: "m", thinkingLevel: "xhigh", enableThinking: true }, conversation: { assemble: (request) => ({ messages: request.messages }) }, credentials: makeInMemoryCredentials(), approval: makeInMemoryApproval(), egress: { emit: () => {} }, diag: { log: () => {} } });
      await handler.onChatRequest(chatRequestToDomain({ requestId: "r", messages: [{ role: "user", content: "hi" }], ...(raw === undefined ? {} : { thinking: { level: raw } }), ...(enabled === undefined ? {} : { enableThinking: enabled }) }));
      expect(bodies.length).toBeGreaterThan(0);
      if (route === "gateway") {
        if (enabled === undefined) expect(bodies[0]?.reasoning_effort).toBe("xhigh");
        else expect(bodies[0]).not.toHaveProperty("reasoning_effort");
      } else expect(bodies[0]?.think).toBe(enabled === undefined ? true : enabled);
    }
  }
});
