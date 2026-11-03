import { describe, expect, it, vi } from "vitest";
import { axApprovalFor, type AxEffect } from "../main/domain/ax-approval-policy.js";
import { makeAxPolicyToolExecutor, type AxApprovalRequest } from "../main/adapters/ax-policy-tool-executor.js";
import type { ToolExecutorPort } from "../main/ports/uc1.js";

const call = { id: "c1", name: "calendar", args: { event: { title: "meeting", destination: "private" } } };
const diag = { log: vi.fn(), debug: vi.fn() };
function setup(effects: readonly AxEffect[], approvals: {
  conversationApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  codeApproval?: (request: AxApprovalRequest) => Promise<boolean>;
} = {}) {
  const execute = vi.fn(async () => ({ output: "ok" }));
  const executor: ToolExecutorPort = { specs: () => [{ name: "calendar", parameters: {}, description: "test", tier: "ask" }], execute };
  const gate = makeAxPolicyToolExecutor({ executor, classify: () => effects, diag, ...approvals });
  return { gate, execute };
}

describe("FR-AX-026 trusted effect policy", () => {
  it.each(["local_read", "local_draft", "reversible_edit"] as const)("%s proceeds without approval", async (effect) => {
    const { gate, execute } = setup([effect]);
    expect(axApprovalFor([effect])).toBe("allow");
    expect(await gate.execute(call, {})).toEqual({ output: "ok" });
    expect(execute).toHaveBeenCalledOnce();
    expect(gate.specs()[0].tier).toBe("none");
  });
  it.each(["external_send", "external_processing", "calendar_write"] as const)("%s needs conversational consent", async (effect) => {
    const approve = vi.fn(async () => true);
    const { gate, execute } = setup([effect], { conversationApproval: approve });
    expect(axApprovalFor([effect])).toBe("conversation");
    await gate.execute(call, { requestId: "r1" });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ call, requestId: "r1", effects: [effect] }));
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(["permanent_delete", "payment", "production_change"] as const)("%s cannot use conversational approval", async (effect) => {
    const conversationApproval = vi.fn(async () => true);
    const { gate, execute } = setup([effect], { conversationApproval });
    expect(axApprovalFor([effect])).toBe("code");
    expect((await gate.execute(call, {})).isError).toBe(true);
    expect(conversationApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const approved = setup([effect], { codeApproval: async () => true });
    expect(await approved.gate.execute(call, {})).toEqual({ output: "ok" });
  });
  it("strongest effect wins regardless of order, unknown/empty denies", () => {
    expect(axApprovalFor(["local_read", "payment", "external_send"])).toBe("code");
    expect(axApprovalFor(["external_send", "local_read"])).toBe("conversation");
    expect(axApprovalFor([])).toBe("deny");
    expect(axApprovalFor(["payment", "made_up" as AxEffect])).toBe("deny");
  });
  it("never invokes an unregistered tool or an unclassified action", async () => {
    const { gate, execute } = setup([]);
    expect((await gate.execute(call, {})).isError).toBe(true);
    expect((await gate.execute({ ...call, name: "unknown" }, {})).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it("waits for approval, then executes the exact frozen snapshot", async () => {
    let accept!: (value: boolean) => void;
    let request: AxApprovalRequest | undefined;
    const approval = new Promise<boolean>((resolve) => { accept = resolve; });
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: async (r) => { request = r; return approval; } });
    const mutable = structuredClone(call);
    const pending = gate.execute(mutable, { requestId: "r" });
    expect(execute).not.toHaveBeenCalled();
    mutable.args.event.destination = "public";
    expect(request?.call.args).toEqual(call.args);
    expect(Object.isFrozen((request?.call.args as typeof call.args).event)).toBe(true);
    accept(true);
    await pending;
    expect(execute).toHaveBeenCalledWith(call, { requestId: "r" });
  });
  it("reject, missing consent and consent callback failure never execute", async () => {
    for (const approve of [undefined, async () => false, async () => { throw new Error("private document text"); }]) {
      const { gate, execute } = setup(["external_send"], { conversationApproval: approve });
      const result = await gate.execute(call, {});
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain("private document text");
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("abort before/during approval prevents execution", async () => {
    const controller = new AbortController();
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: async () => { controller.abort(); return true; } });
    await expect(gate.execute(call, { signal: controller.signal })).rejects.toBeDefined();
    await expect(gate.execute(call, { signal: controller.signal })).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it("diagnostics do not contain the call payload", async () => {
    diag.debug.mockClear();
    await setup(["local_read"]).gate.execute(call, {});
    expect(JSON.stringify(diag.debug.mock.calls)).not.toContain("meeting");
    expect(JSON.stringify(diag.debug.mock.calls)).not.toContain("private");
  });
  it("cancels an uncooperative approval and ignores its late acceptance", async () => {
    let accept!: (value: boolean) => void;
    const approval = new Promise<boolean>((resolve) => { accept = resolve; });
    const controller = new AbortController();
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: () => approval });
    const pending = gate.execute(call, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    accept(true);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects non-JSON mutable objects before requesting consent", async () => {
    const approve = vi.fn(async () => true);
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: approve });
    expect((await gate.execute({ ...call, args: { date: new Date() } }, {})).isError).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
