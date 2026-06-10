// UC5 도구 루프 — 실 stdio 관통 통합 (계약 §B.6 "실 stdio 구동"). in-memory LineIO 로 전 합성
// (ingress decodeRequest → ChatTurnHandler 루프 → egress encodeEmit → wire line) 을 wire 레벨로 검증.
import { describe, it, expect } from "vitest";
import { wireAgentUC1 } from "../main/composition/index.js";
import { makeFakeToolProvider } from "../main/adapters/fake-provider.js";
import { makeEchoToolExecutor } from "../main/adapters/echo-tool-executor.js";

function memIO() {
  const out: string[] = [];
  let cb: ((l: string) => void) | null = null;
  return {
    io: { writeLine: (l: string) => out.push(l), onLine: (c: (l: string) => void) => { cb = c; return () => { cb = null; }; } },
    out,
    feed: (l: string) => cb?.(l),
  };
}
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("waitFor timeout");
}
const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("UC5 도구 루프 — 실 stdio 관통", () => {
  it("chat_request → 도구 루프 wire 시퀀스(tool_use→tool_result→text→usage→finish), requestId 결속", async () => {
    const { io, out, feed } = memIO();
    const { start } = wireAgentUC1({ io, provider: makeFakeToolProvider(), toolExecutor: makeEchoToolExecutor() });
    start?.();
    feed(JSON.stringify({ type: "chat_request", requestId: "w1", provider: { provider: "fake", model: "m" }, messages: [{ role: "user", content: "hi" }] }));
    await waitFor(() => out.some((l) => (JSON.parse(l) as { type: string }).type === "finish"));

    const msgs = parse(out);
    expect(msgs.map((m) => m["type"])).toEqual(["tool_use", "tool_result", "text", "usage", "finish"]);
    expect(msgs.every((m) => m["requestId"] === "w1")).toBe(true); // 전 메시지 requestId 결속
    const tr = msgs.find((m) => m["type"] === "tool_result");
    expect(tr?.["output"]).toBe("hello-from-tool"); // echo(args.text) 실행 결과가 wire 로
    const tu = msgs.find((m) => m["type"] === "tool_use");
    expect(tu?.["toolName"]).toBe("echo"); // 실행 도구명 wire 노출
  });
});
