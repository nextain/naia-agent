// mcp-stdio-transport(JSON-RPC client) 계약 테스트 — fake LineChannel(실 subprocess 0). id상관·error·abort·바이트한도.
import { describe, it, expect } from "vitest";
import { makeMcpJsonRpcClient, type LineChannel } from "../main/adapters/mcp-stdio-transport.js";

// fake 채널: send 기록 + 수동으로 서버 줄 주입(emit). 보통 send 직후 응답 자동 echo 옵션.
function fakeChannel(opts: { auto?: (sent: Record<string, unknown>) => Record<string, unknown> | null } = {}) {
  const sent: Record<string, unknown>[] = [];
  let cb: ((line: string) => void) | null = null;
  let closed = false;
  const ch: LineChannel = {
    send(line) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      sent.push(msg);
      if (opts.auto) { const resp = opts.auto(msg); if (resp) queueMicrotask(() => cb?.(JSON.stringify(resp))); }
    },
    onLine(c) { cb = c; return () => { cb = null; }; },
    close() { closed = true; },
  };
  return { ch, sent, emit: (o: unknown) => cb?.(typeof o === "string" ? o : JSON.stringify(o)), isClosed: () => closed };
}

describe("makeMcpJsonRpcClient (S25 transport)", () => {
  it("request → id 상관 → result resolve", async () => {
    const f = fakeChannel({ auto: (m) => ({ jsonrpc: "2.0", id: m.id, result: { ok: true, echo: m.method } }) });
    const c = makeMcpJsonRpcClient(f.ch);
    const r = await c.request("tools/list", {}, {});
    expect(r).toEqual({ ok: true, echo: "tools/list" });
    expect(f.sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  });
  it("동시 다중 request → id 별 올바른 매칭", async () => {
    const f = fakeChannel({ auto: (m) => ({ jsonrpc: "2.0", id: m.id, result: m.id }) });
    const c = makeMcpJsonRpcClient(f.ch);
    const [a, b, d] = await Promise.all([c.request("m", {}, {}), c.request("m", {}, {}), c.request("m", {}, {})]);
    expect([a, b, d]).toEqual([1, 2, 3]); // 각 result=자기 id
  });
  it("JSON-RPC error → reject(message)", async () => {
    const f = fakeChannel({ auto: (m) => ({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }) });
    const c = makeMcpJsonRpcClient(f.ch);
    await expect(c.request("bad", {}, {})).rejects.toThrow("method not found");
  });
  it("이미 aborted signal → reject·전송 안 함", async () => {
    const f = fakeChannel();
    const c = makeMcpJsonRpcClient(f.ch);
    const ac = new AbortController(); ac.abort();
    await expect(c.request("m", {}, { signal: ac.signal })).rejects.toThrow();
    expect(f.sent.length).toBe(0);
  });
  it("응답 전 abort → reject(pending 정리)", async () => {
    const f = fakeChannel(); // auto 없음 → 응답 안 옴
    const c = makeMcpJsonRpcClient(f.ch);
    const ac = new AbortController();
    const p = c.request("m", {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
  });
  it("바이트한도 초과 응답 줄 → 미결 전체 reject", async () => {
    const f = fakeChannel();
    const c = makeMcpJsonRpcClient(f.ch, { byteLimit: 100 });
    const p = c.request("m", {}, {});
    f.emit("x".repeat(200)); // 100 초과 줄
    await expect(p).rejects.toThrow(/byte limit/);
  });
  it("알림(id 없는 서버 줄) → 무시(미결 영향 없음)", async () => {
    const f = fakeChannel({ auto: (m) => ({ jsonrpc: "2.0", id: m.id, result: "ok" }) });
    const c = makeMcpJsonRpcClient(f.ch);
    f.emit({ jsonrpc: "2.0", method: "notifications/progress", params: {} }); // id 없음
    expect(await c.request("m", {}, {})).toBe("ok"); // 정상 동작 유지
  });
  it("파싱 실패/빈 줄 → 무시(throw 안 함)", async () => {
    const f = fakeChannel({ auto: (m) => ({ jsonrpc: "2.0", id: m.id, result: "ok" }) });
    const c = makeMcpJsonRpcClient(f.ch);
    f.emit("not json{"); f.emit("");
    expect(await c.request("m", {}, {})).toBe("ok");
  });
  it("미지/중복 id 응답 → 무시", async () => {
    const f = fakeChannel();
    const c = makeMcpJsonRpcClient(f.ch);
    const p = c.request("m", {}, {});
    f.emit({ jsonrpc: "2.0", id: 999, result: "wrong" }); // 미지 id
    f.emit({ jsonrpc: "2.0", id: 1, result: "right" });    // 실제 id
    f.emit({ jsonrpc: "2.0", id: 1, result: "dup" });      // 중복(이미 resolve)
    expect(await p).toBe("right");
  });
  it("notify → id 없는 메시지 전송·resolve", async () => {
    const f = fakeChannel();
    const c = makeMcpJsonRpcClient(f.ch);
    await c.notify("notifications/initialized", undefined);
    expect(f.sent[0]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" }); // params 생략
    expect("id" in f.sent[0]).toBe(false);
  });
  it("dispose → 미결 reject + 채널 close", async () => {
    const f = fakeChannel();
    const c = makeMcpJsonRpcClient(f.ch);
    const p = c.request("m", {}, {});
    c.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(f.isClosed()).toBe(true);
    await expect(c.request("m2", {}, {})).rejects.toThrow(/disposed/); // dispose 후 요청 거부
  });
});
