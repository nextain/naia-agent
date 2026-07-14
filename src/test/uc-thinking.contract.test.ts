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
import type { ProviderChunk, ProviderConfig } from "../main/domain/chat.js";

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
