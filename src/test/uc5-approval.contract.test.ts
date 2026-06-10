// UC5 slice 2 승인 게이트 계약 테스트 (§D.5) — handler 승인 분기 + makeInMemoryApproval 유닛.
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeEchoToolExecutor } from "../main/adapters/echo-tool-executor.js";
import { makeFakeToolProvider } from "../main/adapters/fake-provider.js";
import type { ProviderPort, ToolExecutorPort } from "../main/ports/uc1.js";
import type { AgentEmit, ChatRequest } from "../main/domain/chat.js";

function setup(over: Partial<HandlerDeps>) {
  const emits: AgentEmit[] = [];
  const approval = over.approval ?? makeInMemoryApproval();
  const deps: HandlerDeps = {
    provider: makeFakeToolProvider(),
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: { update: () => {}, get: () => undefined },
    approval,
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: () => {} },
    toolExecutor: makeEchoToolExecutor(),
    ...over,
  };
  return { handler: new ChatTurnHandler(deps), emits, approval };
}
const REQ = (over: Partial<ChatRequest> = {}): ChatRequest => ({ kind: "chat", requestId: "r1", provider: { provider: "fake", model: "m" }, messages: [{ role: "user", content: "hi" }], ...over });
const kinds = (es: AgentEmit[]) => es.map((e) => e.kind);
const pick = <K extends AgentEmit["kind"]>(es: AgentEmit[], k: K) => es.filter((e) => e.kind === k) as Extract<AgentEmit, { kind: K }>[];
async function waitFor(cond: () => boolean) { for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("waitFor timeout"); }

// tier "ask" 도구 danger + 비-gated echo.
const gatedExec: ToolExecutorPort = {
  specs: () => [{ name: "danger", description: "", parameters: {}, tier: "ask" }, { name: "echo", description: "", parameters: {} }],
  async execute(call) { return { output: `ran ${call.name}` }; },
};
const gatedProv = (toolName = "danger"): ProviderPort => ({
  async *chat(_c, messages, o) {
    if (o.signal?.aborted) return;
    if (!messages.some((m) => m.role === "tool")) { yield { kind: "toolUse", id: "g1", name: toolName, args: {} }; yield { kind: "usage", inputTokens: 1, outputTokens: 1 }; yield { kind: "finish" }; }
    else { yield { kind: "text", text: "done" }; yield { kind: "finish" }; }
  },
});

describe("UC5 slice 2 승인 게이트 (§D.5)", () => {
  it("(a) gated approve → toolUse→approval_request→execute→toolResult→finish", async () => {
    const { handler, emits } = setup({ provider: gatedProv(), toolExecutor: gatedExec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => emits.some((e) => e.kind === "approvalRequest"));
    const ar = pick(emits, "approvalRequest")[0];
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: ar.toolCallId, decision: "approve" });
    await p;
    expect(kinds(emits)).toEqual(["toolUse", "approvalRequest", "toolResult", "text", "usage", "finish"]);
    expect(pick(emits, "toolResult")[0].output).toBe("ran danger"); // 실행됨
    expect(ar.tier).toBe("ask");
  });

  it("(b) gated reject → toolResult(거부), execute 안 함, 복구 finish", async () => {
    const { handler, emits } = setup({ provider: gatedProv(), toolExecutor: gatedExec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => emits.some((e) => e.kind === "approvalRequest"));
    const ar = pick(emits, "approvalRequest")[0];
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: ar.toolCallId, decision: "reject" });
    await p;
    expect(kinds(emits)).toEqual(["toolUse", "approvalRequest", "toolResult", "text", "usage", "finish"]);
    expect(pick(emits, "toolResult")[0].output).toMatch(/거부/); // 실행 안 됨(ran danger 아님)
  });

  it("(c) non-gated 도구 → approval_request 미방출(slice 1 동일)", async () => {
    const { handler, emits } = setup({ provider: makeFakeToolProvider(), toolExecutor: makeEchoToolExecutor() });
    await handler.onChatRequest(REQ());
    expect(emits.some((e) => e.kind === "approvalRequest")).toBe(false);
    expect(kinds(emits)).toEqual(["toolUse", "toolResult", "text", "usage", "finish"]);
  });

  it("(d) approval 대기 중 cancel → cancelled terminal, toolResult 미emit, usage 1회", async () => {
    const { handler, emits } = setup({ provider: gatedProv(), toolExecutor: gatedExec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => emits.some((e) => e.kind === "approvalRequest"));
    handler.onCancel({ kind: "cancel", requestId: "r1" });
    await p;
    const last = emits[emits.length - 1];
    expect(last.kind === "error" && last.message).toBe("cancelled");
    expect(emits.some((e) => e.kind === "toolResult")).toBe(false);
    expect(pick(emits, "usage").length).toBe(1);
  });

  it("(e) 혼합(gated danger + non-gated echo) 순서·쌍", async () => {
    const prov: ProviderPort = {
      async *chat(_c, messages, o) {
        if (o.signal?.aborted) return;
        if (!messages.some((m) => m.role === "tool")) {
          yield { kind: "toolUse", id: "d1", name: "danger", args: {} };
          yield { kind: "toolUse", id: "e1", name: "echo", args: {} };
          yield { kind: "finish" };
        } else { yield { kind: "text", text: "done" }; yield { kind: "finish" }; }
      },
    };
    const { handler, emits } = setup({ provider: prov, toolExecutor: gatedExec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => emits.some((e) => e.kind === "approvalRequest"));
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: pick(emits, "approvalRequest")[0].toolCallId, decision: "approve" });
    await p;
    // danger: toolUse→approval_request→toolResult, echo: toolUse→toolResult(비-gated)
    expect(kinds(emits)).toEqual(["toolUse", "approvalRequest", "toolResult", "toolUse", "toolResult", "text", "usage", "finish"]);
  });

  it("(f) 미지 approval_response(보류 없는 id) → no-op(정상 승인엔 영향 없음)", async () => {
    const { handler, emits } = setup({ provider: gatedProv(), toolExecutor: gatedExec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => emits.some((e) => e.kind === "approvalRequest"));
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: "WRONG", decision: "approve" }); // no-op
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "WRONG", toolCallId: pick(emits, "approvalRequest")[0].toolCallId, decision: "approve" }); // no-op
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: pick(emits, "approvalRequest")[0].toolCallId, decision: "approve" }); // 정상
    await p;
    expect(pick(emits, "toolResult")[0].output).toBe("ran danger");
  });

  it("(k) cid turn-unique: 두 라운드 같은 call.id → 2라운드 round 접미사로 한정(approval_request id 상이)", async () => {
    const prov: ProviderPort = {
      async *chat(_c, messages, o) {
        if (o.signal?.aborted) return;
        const rounds = messages.filter((m) => m.role === "tool").length;
        if (rounds < 2) { yield { kind: "toolUse", id: "call_0", name: "danger", args: {} }; yield { kind: "finish" }; }
        else { yield { kind: "text", text: "done" }; yield { kind: "finish" }; }
      },
    };
    const { handler, emits } = setup({ provider: prov, toolExecutor: gatedExec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => pick(emits, "approvalRequest").length === 1);
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: pick(emits, "approvalRequest")[0].toolCallId, decision: "approve" });
    await waitFor(() => pick(emits, "approvalRequest").length === 2);
    handler.onApprovalResponse({ kind: "approvalResponse", requestId: "r1", toolCallId: pick(emits, "approvalRequest")[1].toolCallId, decision: "approve" });
    await p;
    const ids = pick(emits, "approvalRequest").map((e) => e.toolCallId);
    expect(ids[0]).toBe("call_0");
    expect(ids[1]).not.toBe("call_0"); // round 접미사로 turn-unique
  });
});

describe("makeInMemoryApproval 유닛 (§D.2)", () => {
  it("(g) register→resolve → promise approve (fast resolve 유실 없음)", async () => {
    const ap = makeInMemoryApproval();
    const { promise } = ap.prepareDecision("r", "t", {});
    ap.resolve("r", "t", "approve"); // 등록 후 즉시
    expect(await promise).toBe("approve");
  });
  it("(i) 이미 aborted signal → 즉시 reject(영구 대기 없음)", async () => {
    const ac = new AbortController(); ac.abort();
    const ap = makeInMemoryApproval();
    const { promise } = ap.prepareDecision("r", "t", { signal: ac.signal });
    await expect(promise).rejects.toThrow();
  });
  it("(i2) await 중 abort → reject", async () => {
    const ac = new AbortController();
    const ap = makeInMemoryApproval();
    const { promise } = ap.prepareDecision("r", "t", { signal: ac.signal });
    ac.abort();
    await expect(promise).rejects.toThrow();
  });
  it("(h) dispose → reject, idempotent(2회 무해), resolve 후 dispose=no-op", async () => {
    const ap = makeInMemoryApproval();
    const d1 = ap.prepareDecision("r", "t1", {});
    d1.dispose(); d1.dispose(); // idempotent
    await expect(d1.promise).rejects.toThrow();
    const d2 = ap.prepareDecision("r", "t2", {});
    ap.resolve("r", "t2", "approve");
    d2.dispose(); // 이미 해소 → no-op
    expect(await d2.promise).toBe("approve");
  });
  it("(f-unit) 미등록/이미해소 resolve → no-op(throw 없음)", () => {
    const ap = makeInMemoryApproval();
    expect(() => ap.resolve("nope", "x", "approve")).not.toThrow();
    const { promise, dispose } = ap.prepareDecision("r", "t", {});
    void promise.catch(() => {}); // 호출자(=handler) 가 항상 부착하는 관찰자 — 미관찰 reject 방지
    dispose();
    expect(() => ap.resolve("r", "t", "approve")).not.toThrow(); // 이미 해소 → no-op
  });
});
