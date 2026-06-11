// composite-tool-executor 계약 테스트.
import { describe, it, expect } from "vitest";
import { makeCompositeToolExecutor } from "../main/adapters/composite-tool-executor.js";
import type { ToolExecutorPort } from "../main/ports/uc1.js";

const mk = (names: { name: string; tier?: string }[], out: string): ToolExecutorPort & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    specs: () => names.map((n) => ({ name: n.name, description: "", parameters: {}, ...(n.tier ? { tier: n.tier } : {}) })),
    async execute(call) { calls.push(call.name); return { output: `${out}:${call.name}` }; },
  };
};

describe("makeCompositeToolExecutor", () => {
  it("specs 병합 + execute name 소유 executor 로 위임", async () => {
    const a = mk([{ name: "x" }, { name: "y" }], "A");
    const b = mk([{ name: "z", tier: "ask" }], "B");
    const c = makeCompositeToolExecutor([a, b]);
    expect(c.specs().map((s) => s.name).sort()).toEqual(["x", "y", "z"]);
    expect(c.specs().find((s) => s.name === "z")?.tier).toBe("ask"); // tier 보존
    expect((await c.execute({ id: "1", name: "y", args: {} }, {})).output).toBe("A:y");
    expect((await c.execute({ id: "2", name: "z", args: {} }, {})).output).toBe("B:z");
    expect(a.calls).toEqual(["y"]); expect(b.calls).toEqual(["z"]);
  });
  it("name 충돌 → 첫 executor 우선(후순위 drop)", async () => {
    const a = mk([{ name: "dup" }], "A");
    const b = mk([{ name: "dup" }], "B");
    const c = makeCompositeToolExecutor([a, b]);
    expect(c.specs().filter((s) => s.name === "dup").length).toBe(1); // 중복 drop
    expect((await c.execute({ id: "1", name: "dup", args: {} }, {})).output).toBe("A:dup"); // 첫 우선
    expect(b.calls).toEqual([]); // 후순위 미호출
  });
  it("미등록 name → isError(no-throw)", async () => {
    const c = makeCompositeToolExecutor([mk([{ name: "x" }], "A")]);
    const r = await c.execute({ id: "1", name: "nope", args: {} }, {});
    expect(r.isError).toBe(true); expect(r.output).toMatch(/unknown tool: nope/);
  });
  it("빈 executors → specs [] · 모든 호출 isError", async () => {
    const c = makeCompositeToolExecutor([]);
    expect(c.specs()).toEqual([]);
    expect((await c.execute({ id: "1", name: "x", args: {} }, {})).isError).toBe(true);
  });
  it("abort 등 child reject 전파(위임)", async () => {
    const ex: ToolExecutorPort = { specs: () => [{ name: "a", description: "", parameters: {} }], async execute() { throw new Error("aborted"); } };
    await expect(makeCompositeToolExecutor([ex]).execute({ id: "1", name: "a", args: {} }, {})).rejects.toThrow(/aborted/);
  });
});
