// mcp-skills 계약 테스트(§G) — 주입 fake transport(실 MCP 서버/소켓 0). 발견·매핑·검증·abort·cap.
import { describe, it, expect } from "vitest";
import { makeMcpSkillsExecutor, type McpTransport } from "../main/adapters/mcp-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const CALL = (name: string, args: unknown): ToolCall => ({ id: "c", name, args });

// fake transport 빌더: initialize/tools-list/tools-call 응답을 스크립트로 지정. 호출 기록.
function mk(opts: {
  init?: unknown;
  pages?: unknown[]; // tools/list 페이지 순서대로
  call?: (name: string, args: unknown) => unknown; // tools/call 응답
  onNotify?: (m: string) => void;
  reqErr?: (method: string) => Error | null; // 특정 method 에서 reject
}): McpTransport {
  let pageIdx = 0;
  const calls: string[] = [];
  const t: McpTransport & { calls: string[] } = {
    calls,
    async request(method, params, _o) {
      calls.push(method);
      const e = opts.reqErr?.(method); if (e) throw e;
      if (method === "initialize") return opts.init ?? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } };
      if (method === "tools/list") { const p = opts.pages?.[pageIdx] ?? { tools: [] }; pageIdx++; return p; }
      if (method === "tools/call") { const a = params as { name: string; arguments: unknown }; return opts.call ? opts.call(a.name, a.arguments) : { content: [{ type: "text", text: "ok" }] }; }
      return {};
    },
    async notify(m, _p, _o) { opts.onNotify?.(m); },
  };
  return t;
}
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `d-${name}`, inputSchema: { type: "object", properties: {}, ...extra } });

describe("makeMcpSkillsExecutor (S25)", () => {
  it("(a) initialize+capabilities.tools+tools/list → specs 매핑(prefix·tier ask)", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("echo"), tool("add")] }] }), serverName: "srv" });
    const specs = ex.specs();
    expect(specs.map((s) => s.name)).toEqual(["mcp__srv__echo", "mcp__srv__add"]);
    expect(specs.every((s) => s.tier === "ask")).toBe(true);
  });
  it("(b) execute(prefixed) → 원본 복원·tools/call·text 추출", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("echo")] }], call: (n) => ({ content: [{ type: "text", text: `called:${n}` }] }) }), serverName: "srv" });
    const r = await ex.execute(CALL("mcp__srv__echo", {}), {});
    expect(r.output).toBe("called:echo"); // 원본 이름 echo 로 위임
  });
  it("(c) result.isError → isError 전파", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }], call: () => ({ content: [{ type: "text", text: "boom" }], isError: true }) }), serverName: "srv" });
    expect((await ex.execute(CALL("mcp__srv__x", {}), {})).isError).toBe(true);
  });
  it("(d) 미등록/위조 prefix 도구명 → isError(tools/call 미호출)", async () => {
    const tr = mk({ pages: [{ tools: [tool("x")] }] }) as McpTransport & { calls: string[] };
    const ex = await makeMcpSkillsExecutor({ transport: tr, serverName: "srv" });
    const before = tr.calls.length;
    expect((await ex.execute(CALL("mcp__srv__nope", {}), {})).isError).toBe(true);
    expect((await ex.execute(CALL("mcp__other__x", {}), {})).isError).toBe(true);
    expect(tr.calls.length).toBe(before); // tools/call 안 함
  });
  it("(e) arg 비객체/required 누락/타입불일치 → isError(tools/call 전)", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x", { properties: { a: { type: "string" } }, required: ["a"] })] }] }), serverName: "srv" });
    expect((await ex.execute(CALL("mcp__srv__x", null), {})).isError).toBe(true);   // 비객체
    expect((await ex.execute(CALL("mcp__srv__x", {}), {})).isError).toBe(true);      // required a 누락
    expect((await ex.execute(CALL("mcp__srv__x", { a: 5 }), {})).isError).toBe(true); // 타입(number≠string)
    expect((await ex.execute(CALL("mcp__srv__x", { a: "ok" }), {})).isError).toBeFalsy(); // 정상
  });
  it("(f) 손상 tools/list(비배열·name 누락·bad schema) → 해당 tool skip", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("good"), { description: "no name" }, { name: "noschema" }, tool("ok2")] }] }), serverName: "srv" });
    expect(ex.specs().map((s) => s.name)).toEqual(["mcp__srv__good", "mcp__srv__ok2"]); // 손상 2개 skip
  });
  it("(g) transport throw(non-abort) → isError(no-throw)", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }], call: () => { throw new Error("net"); } }), serverName: "srv" });
    const r = await ex.execute(CALL("mcp__srv__x", {}), {});
    expect(r.isError).toBe(true); expect(r.output).toContain("net");
  });
  it("(h) 이미 aborted → reject(진입)", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }] }), serverName: "srv" });
    const ac = new AbortController(); ac.abort();
    await expect(ex.execute(CALL("mcp__srv__x", {}), { signal: ac.signal })).rejects.toThrow();
  });
  it("(i) request 직후 abort → reject", async () => {
    const ac = new AbortController();
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }], call: () => { ac.abort(); return { content: [{ type: "text", text: "late" }] }; } }), serverName: "srv" });
    await expect(ex.execute(CALL("mcp__srv__x", {}), { signal: ac.signal })).rejects.toThrow();
  });
  it("(j) 과대 content text → 8000 cap '생략'", async () => {
    const big = "a".repeat(20000);
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }], call: () => ({ content: [{ type: "text", text: big }] }) }), serverName: "srv" });
    const r = await ex.execute(CALL("mcp__srv__x", {}), {});
    expect(r.output.length).toBeLessThanOrEqual(8000 + 20); expect(r.output).toContain("생략");
  });
  it("(k) 비-text content → '[non-text 생략]'", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }], call: () => ({ content: [{ type: "image", data: "..." }] }) }), serverName: "srv" });
    expect((await ex.execute(CALL("mcp__srv__x", {}), {})).output).toContain("non-text");
  });
  it("(l) maxTools 초과 → cap", async () => {
    const many = Array.from({ length: 10 }, (_, i) => tool(`t${i}`));
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: many }] }), serverName: "srv", maxTools: 3 });
    expect(ex.specs().length).toBe(3);
  });
  it("(n) capabilities.tools 미광고 → tools/list 미호출·빈 specs", async () => {
    const tr = mk({ init: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } } }) as McpTransport & { calls: string[] };
    const ex = await makeMcpSkillsExecutor({ transport: tr, serverName: "srv" });
    expect(ex.specs()).toEqual([]);
    expect(tr.calls.includes("tools/list")).toBe(false);
  });
  it("(o) nextCursor → 페이지 루프", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("a")], nextCursor: "p2" }, { tools: [tool("b")] }] }), serverName: "srv" });
    expect(ex.specs().map((s) => s.name)).toEqual(["mcp__srv__a", "mcp__srv__b"]);
  });
  it("(p) CallToolResult.content 누락/비배열 → isError", async () => {
    const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }], call: () => ({ result: "no content" }) }), serverName: "srv" });
    expect((await ex.execute(CALL("mcp__srv__x", {}), {})).isError).toBe(true);
  });
  it("(q) 미지원/손상 initialize → 팩토리 reject", async () => {
    await expect(makeMcpSkillsExecutor({ transport: mk({ init: { capabilities: {} } }), serverName: "srv" })).rejects.toThrow();
  });
  it("(r) init 안 끝남(initTimeoutMs deadline → signal abort) → 팩토리 reject", async () => {
    // 계약: transport.request 는 abort signal 시 reject(실 어댑터 책임). 팩토리 deadline 이 signal abort → reject.
    const hang: McpTransport = {
      request: (_m, _p, o) => new Promise((_res, rej) => { o?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); }),
      notify: async () => {},
    };
    await expect(makeMcpSkillsExecutor({ transport: hang, serverName: "srv", initTimeoutMs: 60 })).rejects.toThrow();
  });
  it("(s) sanitize 후 exposed 충돌 → 결정적 reject", async () => {
    // 같은 tool name 중복 = 같은 exposed → reject
    await expect(makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("dup"), tool("dup")] }] }), serverName: "srv" })).rejects.toThrow();
  });
  it("(t) cursor 순환(반복 nextCursor) → reject", async () => {
    await expect(makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("a")], nextCursor: "x" }, { tools: [tool("b")], nextCursor: "x" }] }), serverName: "srv" })).rejects.toThrow();
  });
  it("(u) nextCursor 비-string → reject", async () => {
    await expect(makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("a")], nextCursor: 5 }] }), serverName: "srv" })).rejects.toThrow();
  });
  it("(v) initialized 알림이 tools/list 전 전송", async () => {
    const order: string[] = [];
    const tr: McpTransport = {
      async request(m) { order.push(`req:${m}`); if (m === "initialize") return { protocolVersion: "1", capabilities: { tools: {} }, serverInfo: {} }; return { tools: [] }; },
      async notify(m) { order.push(`notify:${m}`); },
    };
    await makeMcpSkillsExecutor({ transport: tr, serverName: "srv" });
    const ni = order.indexOf("notify:notifications/initialized");
    const tl = order.indexOf("req:tools/list");
    expect(ni).toBeGreaterThanOrEqual(0); expect(ni).toBeLessThan(tl); // initialized 가 tools/list 보다 먼저
  });
  it("(m) defaultTier 미지정→ask / 유효값→그값 / 오타→ask", async () => {
    const none = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }] }), serverName: "s", defaultTier: "none" });
    expect(none.specs()[0].tier).toBe("none");
    const bad = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: [tool("x")] }] }), serverName: "s", defaultTier: "bogus" });
    expect(bad.specs()[0].tier).toBe("ask");
  });
  it("(w) maxTools 0/음수/NaN → 기본100", async () => {
    const many = Array.from({ length: 5 }, (_, i) => tool(`t${i}`));
    for (const mt of [0, -1, Number.NaN, 1.5]) {
      const ex = await makeMcpSkillsExecutor({ transport: mk({ pages: [{ tools: many }] }), serverName: "s", maxTools: mt as number });
      expect(ex.specs().length).toBe(5); // 기본 100 → 5개 다 노출
    }
  });
});
