// UC-PANEL 계약 — panel-tool-executor(환경 도구 위임). FR-PANEL-1~5.
// E1: agent 는 실행 안 함 — execute()=panel_tool_call emit→PanelToolResult 대기. fake egress 로 emit 캡처(실 gRPC 무의존).
import { describe, it, expect, vi } from "vitest";
import { makePanelToolExecutor } from "../main/adapters/panel-tool-executor.js";
import { makeCompositeToolExecutor } from "../main/adapters/composite-tool-executor.js";
import type { AgentEgressPort, ToolExecutorPort } from "../main/ports/uc1.js";
import type { AgentEmit } from "../main/domain/chat.js";

function fakeEgress() {
  const emitted: { requestId: string; e: AgentEmit }[] = [];
  const egress: AgentEgressPort = { emit: (requestId, e) => { emitted.push({ requestId, e }); } };
  return { egress, emitted };
}

describe("panel-tool-executor (UC-PANEL FR-PANEL)", () => {
  it("FR-PANEL-1: register → specs 노출, clear → 제거", () => {
    const { egress } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    expect(p.specs()).toEqual([]);
    p.register("browser", [{ name: "skill_browser_navigate", description: "nav", parameters: { type: "object" } }]);
    p.register("bgm", [{ name: "skill_youtube_bgm", description: "bgm", parameters: {} }]);
    expect(p.specs().map((s) => s.name).sort()).toEqual(["skill_browser_navigate", "skill_youtube_bgm"]);
    p.clear("browser");
    expect(p.specs().map((s) => s.name)).toEqual(["skill_youtube_bgm"]);
  });

  it("FR-PANEL-2/3: execute → panel_tool_call emit + PanelToolResult(requestId+toolCallId) 로 해소", async () => {
    const { egress, emitted } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    const resP = p.execute({ id: "tc1", name: "skill_x", args: { a: 1 } }, { requestId: "req1" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].requestId).toBe("req1");
    expect(emitted[0].e).toMatchObject({ kind: "panelToolCall", toolCallId: "tc1", toolName: "skill_x", args: { a: 1 } });
    p.resolveResult("req1", "tc1", "done", true);
    await expect(resP).resolves.toEqual({ output: "done", isError: false });
  });

  it("FR-PANEL-3: success=false → isError:true", async () => {
    const { egress } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    const resP = p.execute({ id: "tc2", name: "x", args: {} }, { requestId: "r" });
    p.resolveResult("r", "tc2", "boom", false);
    await expect(resP).resolves.toEqual({ output: "boom", isError: true });
  });

  it("requestId 없으면 no-throw error(비-chat 경로 방어) — emit 안 함", async () => {
    const { egress, emitted } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    await expect(p.execute({ id: "t", name: "x", args: {} }, {})).resolves.toMatchObject({ isError: true });
    expect(emitted).toHaveLength(0);
  });

  it("FR-PANEL-4: timeout → isError, 늦은 결과는 no-op(누수 0)", async () => {
    vi.useFakeTimers();
    try {
      const { egress } = fakeEgress();
      const p = makePanelToolExecutor({ egress, timeoutMs: 1000 });
      const resP = p.execute({ id: "tc3", name: "x", args: {} }, { requestId: "r" });
      vi.advanceTimersByTime(1001);
      await expect(resP).resolves.toMatchObject({ isError: true, output: expect.stringContaining("timeout") });
      expect(() => p.resolveResult("r", "tc3", "late", true)).not.toThrow(); // 늦은 결과 무해(단일 settle)
    } finally {
      vi.useRealTimers();
    }
  });

  it("FR-PANEL-4: abort → isError cancelled, 이후 결과 no-op", async () => {
    const { egress } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    const ac = new AbortController();
    const resP = p.execute({ id: "tc4", name: "x", args: {} }, { requestId: "r", signal: ac.signal });
    ac.abort();
    await expect(resP).resolves.toMatchObject({ isError: true });
    expect(() => p.resolveResult("r", "tc4", "late", true)).not.toThrow();
  });

  it("FR-PANEL-4: 다중 동시 execute 독립 매칭(역순 해소)", async () => {
    const { egress } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    const a = p.execute({ id: "A", name: "x", args: {} }, { requestId: "r" });
    const b = p.execute({ id: "B", name: "y", args: {} }, { requestId: "r" });
    p.resolveResult("r", "B", "rb", true);
    p.resolveResult("r", "A", "ra", true);
    expect(await a).toEqual({ output: "ra", isError: false });
    expect(await b).toEqual({ output: "rb", isError: false });
  });

  it("H2 재발방지: 같은 toolCallId 다른 requestId 독립 매칭(동시 turn cid 충돌)", async () => {
    const { egress } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    const turnA = p.execute({ id: "call_1", name: "x", args: {} }, { requestId: "reqA" }); // 같은 cid "call_1"
    const turnB = p.execute({ id: "call_1", name: "x", args: {} }, { requestId: "reqB" });
    p.resolveResult("reqB", "call_1", "B", true);
    p.resolveResult("reqA", "call_1", "A", true);
    expect(await turnA).toEqual({ output: "A", isError: false }); // 교차 오염 없음
    expect(await turnB).toEqual({ output: "B", isError: false });
  });

  it("이미 abort 된 signal → 즉시 isError(emit 전 가드)", async () => {
    const { egress } = fakeEgress();
    const p = makePanelToolExecutor({ egress });
    const ac = new AbortController();
    ac.abort();
    await expect(p.execute({ id: "tc5", name: "x", args: {} }, { requestId: "r", signal: ac.signal })).resolves.toMatchObject({ isError: true });
  });
});

// H1 재발방지: composite 에 동적 panel child 를 끼운 통합(entry 와 동일 합성 순서 = panel 등록 *전* 합성).
// 단위 격리(위 describe)는 이 갭을 구조적으로 못 잡는다 — composite 가 specs 를 구축시점 스냅샷하면 panel 영영 미노출.
describe("composite + 동적 panel 통합 (H1 재발방지)", () => {
  const builtin = (): ToolExecutorPort => ({
    specs: () => [{ name: "get_time", description: "time", parameters: {} }],
    execute: async () => ({ output: "now" }),
  });

  it("panel 등록 전 composite 합성 → 등록 후 specs/execute 동적 반영 + builtin 무회귀 + clear 동적", async () => {
    const { egress, emitted } = fakeEgress();
    const panel = makePanelToolExecutor({ egress });
    const composite = makeCompositeToolExecutor([builtin(), panel]); // ★ entry 와 동일: panel 등록 전에 합성
    expect(composite.specs().map((s) => s.name)).toEqual(["get_time"]);
    panel.register("bgm", [{ name: "skill_youtube_bgm", description: "bgm", parameters: {} }]);
    expect(composite.specs().map((s) => s.name).sort()).toEqual(["get_time", "skill_youtube_bgm"]); // H1: 동적 노출
    const resP = composite.execute({ id: "tc", name: "skill_youtube_bgm", args: {} }, { requestId: "r" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].e).toMatchObject({ kind: "panelToolCall", toolName: "skill_youtube_bgm" }); // 위임 emit
    panel.resolveResult("r", "tc", "playing", true);
    expect(await resP).toEqual({ output: "playing", isError: false });
    expect(await composite.execute({ id: "tc2", name: "get_time", args: {} }, { requestId: "r" })).toEqual({ output: "now" }); // FR-PANEL-5 builtin 무회귀
    panel.clear("bgm");
    expect(composite.specs().map((s) => s.name)).toEqual(["get_time"]); // clear 도 동적 반영
  });
});
