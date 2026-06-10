// ollama ProviderPort 계약 테스트 — mock fetch(실 ollama 없이 NDJSON 스트림 재현).
import { describe, it, expect } from "vitest";
import { makeOllamaProvider } from "../main/adapters/ollama-provider.js";
import type { ProviderChunk, ProviderConfig } from "../main/domain/chat.js";

// NDJSON 줄들을 청크로 쪼개 흘려주는 mock fetch.
function mockFetch(lines: string[], opts: { ok?: boolean; status?: number } = {}) {
  const enc = new TextEncoder();
  return async (_url: string, _init: unknown) => {
    if (opts.ok === false) return { ok: false, status: opts.status ?? 500, statusText: "err", body: null };
    let i = 0;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (i >= lines.length) return { done: true };
        return { done: false, value: enc.encode(lines[i++]!) };
      },
    };
    return { ok: true, status: 200, statusText: "OK", body: { getReader: () => reader } };
  };
}
const cfg: ProviderConfig = { provider: "ollama", model: "gemma4", ollamaHost: "http://h" };
async function collect(gen: AsyncIterable<ProviderChunk>) { const out: ProviderChunk[] = []; for await (const c of gen) out.push(c); return out; }

describe("makeOllamaProvider (native /api/chat, mock fetch)", () => {
  it("NDJSON content delta → per-chunk text 스트림 + usage + finish", async () => {
    const lines = [
      JSON.stringify({ message: { content: "안녕" } }) + "\n",
      JSON.stringify({ message: { content: "하세요" } }) + "\n",
      JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 7 }) + "\n",
    ];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [{ role: "user", content: "hi" }], {}));
    expect(out).toEqual([
      { kind: "text", text: "안녕" }, { kind: "text", text: "하세요" },
      { kind: "usage", inputTokens: 5, outputTokens: 7 }, { kind: "finish" },
    ]); // ⚠️ 스트리밍(per-chunk) — buffer 아님(UC1 목표)
  });
  it("thinking delta → thinking chunk", async () => {
    const lines = [JSON.stringify({ message: { thinking: "음..." } }) + "\n", JSON.stringify({ done: true }) + "\n"];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {}));
    expect(out[0]).toEqual({ kind: "thinking", text: "음..." });
    expect(out[out.length - 1]).toEqual({ kind: "finish" });
  });
  it("청크 경계가 줄 중간이어도 NDJSON 재조립", async () => {
    const lines = ['{"message":{"content":"부분', '1"}}\n{"message":{"content":"부분2"}}\n', '{"done":true}\n'];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {}));
    expect(out.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text)).toEqual(["부분1", "부분2"]);
  });
  it("!ok → throw(handler catch=error)", async () => {
    const gen = makeOllamaProvider({ fetch: mockFetch([], { ok: false, status: 503 }) as never }).chat(cfg, [], {});
    await expect(collect(gen)).rejects.toThrow(/503/);
  });
  it("손상 NDJSON 줄 skip(크래시 없음)", async () => {
    const lines = ["not json\n", JSON.stringify({ message: { content: "ok" } }) + "\n", JSON.stringify({ done: true }) + "\n"];
    const out = await collect(makeOllamaProvider({ fetch: mockFetch(lines) as never }).chat(cfg, [], {}));
    expect(out.some((c) => c.kind === "text" && (c as { text: string }).text === "ok")).toBe(true);
  });
});
