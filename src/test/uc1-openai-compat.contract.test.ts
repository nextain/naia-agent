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
});
