// 키체인 backed CredentialPort 계약 — naia-os write_agent_key(키체인) → agent read-back → resolver 키 획득.
// 계약: docs/progress/UC-provider-provenance-contract-2026-06-12.md
import { describe, it, expect } from "vitest";
import { makeKeychainCredentials, apiKeyEnvFor, classifyProbe } from "../main/adapters/keychain-secret-store.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import { wireAgentUC1 } from "../main/composition/index.js";
// stdio 는 production(composition)에서 제거(transport=gRPC) → 테스트는 stdio 어댑터 직접 사용(in-process wire 검증).
import { makeStdioIngress, makeStdioEgress } from "../main/adapters/stdio.js";

describe("apiKeyEnvFor (provider → env_key, naia-os resolveAgentEnvKey 거울)", () => {
  it("매핑", () => {
    expect(apiKeyEnvFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvFor("openai")).toBe("OPENAI_API_KEY");
    expect(apiKeyEnvFor("glm")).toBe("GLM_API_KEY");
    expect(apiKeyEnvFor("gemini")).toBe("GEMINI_API_KEY");
    expect(apiKeyEnvFor("ollama")).toBeNull(); // 키 불요
  });
});

describe("classifyProbe (secret-tool 가용성, locale-safe)", () => {
  it("found(0)=true, absent+빈stderr(1)=true, 그외=false", () => {
    expect(classifyProbe({ status: 0, stderr: "" })).toBe(true);
    expect(classifyProbe({ status: 1, stderr: "" })).toBe(true);
    expect(classifyProbe({ status: 1, stderr: "dbus error" })).toBe(false);
    expect(classifyProbe({ status: null, stderr: "" })).toBe(false); // killed/missing
    expect(classifyProbe({ error: new Error("ENOENT"), status: null, stderr: "" })).toBe(false);
  });
});

describe("makeKeychainCredentials (주입 read)", () => {
  const store: Record<string, string> = { NAIA_ANYLLM_API_KEY: "naia-LOGIN", GLM_API_KEY: "glm-SECRET" };
  const read = (name: string) => store[name];

  it("get(gemini) → naiaKey(NAIA_ANYLLM_API_KEY) (로그인 → lab-proxy 경로)", () => {
    const c = makeKeychainCredentials({ read });
    expect(c.get("gemini")).toEqual({ naiaKey: "naia-LOGIN" });
  });
  it("get(glm) → apiKey(GLM_API_KEY) + naiaKey", () => {
    const c = makeKeychainCredentials({ read });
    expect(c.get("glm")).toEqual({ apiKey: "glm-SECRET", naiaKey: "naia-LOGIN" });
  });
  it("키 없는 store → undefined(빈 키로 호출 안 하게)", () => {
    const c = makeKeychainCredentials({ read: () => undefined });
    expect(c.get("openai")).toBeUndefined();
  });
  it("creds_update overlay 가 키체인보다 우선", () => {
    const c = makeKeychainCredentials({ read });
    c.update("glm", { apiKey: "RUNTIME-OVERRIDE" });
    expect(c.get("glm")?.apiKey).toBe("RUNTIME-OVERRIDE");
  });
});

describe("wire-through: 키체인 naiaKey → resolver → lab-proxy (라이브 흐름 creds 연결)", () => {
  function memIO() {
    const out: string[] = []; let cb: ((l: string) => void) | null = null;
    return { io: { writeLine: (l: string) => out.push(l), onLine: (c: (l: string) => void) => { cb = c; return () => { cb = null; }; } }, out, feed: (l: string) => cb?.(l) };
  }
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
  async function waitFor(cond: () => boolean) { for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("timeout"); }

  it("config{nextain}(naiaKey 미포함) + 키체인 NAIA_ANYLLM_API_KEY → lab-proxy(api.nextain.io/v1, X-AnyLLM-Key Bearer)", async () => {
    const box: { url?: string; headers?: Record<string, string> } = {};
    const { io, out, feed } = memIO();
    // 셸은 naiaKey 를 wire 에 안 실음(secret strip) — agent 가 키체인서 read-back. nextain(naia 계정)=lab-proxy.
    const credentials = makeKeychainCredentials({ read: (n) => (n === "NAIA_ANYLLM_API_KEY" ? "naia-FROM-KEYCHAIN" : undefined) });
    const resolver = makeProviderResolver({ fetch: sseFetch(box) as never });
    const { start } = wireAgentUC1({ ingress: makeStdioIngress(io), egress: makeStdioEgress(io), credentials, resolver });
    start?.();
    // req.provider 에 naiaKey 없음(셸이 strip) — 키체인 creds 가 채움
    feed(JSON.stringify({ type: "chat_request", requestId: "w1", provider: { provider: "nextain", model: "gemini-2.5-flash" }, messages: [{ role: "user", content: "안녕" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "finish"));

    expect(box.url).toBe("https://api.nextain.io/v1/chat/completions");
    expect(box.headers?.["X-AnyLLM-Key"]).toBe("Bearer naia-FROM-KEYCHAIN");
    const msgs = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(msgs.map((m) => m["type"])).toEqual(["text", "usage", "finish"]);
  });
});
