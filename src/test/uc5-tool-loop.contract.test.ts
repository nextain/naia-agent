// UC5 도구 실행 루프 계약 테스트 (계약 §B.6 a~g) — fake provider + echo executor, 실 LLM 불요.
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeEchoToolExecutor } from "../main/adapters/echo-tool-executor.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeFakeProvider, makeFakeToolProvider } from "../main/adapters/fake-provider.js";
import type { ProviderPort, ToolExecutorPort } from "../main/ports/uc1.js";
import type { AgentEmit, ChatRequest } from "../main/domain/chat.js";

function setup(over: Partial<HandlerDeps> = {}) {
  const emits: AgentEmit[] = [];
  const deps: HandlerDeps = {
    provider: makeFakeToolProvider(),
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: { update: () => {}, get: () => undefined },
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: () => {} },
    toolExecutor: makeEchoToolExecutor(),
    ...over,
  };
  return { handler: new ChatTurnHandler(deps), emits };
}
const REQ = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "fake", model: "m" },
  messages: [{ role: "user", content: "hi" }], ...over,
});
const kinds = (es: AgentEmit[]) => es.map((e) => e.kind);
const pick = <K extends AgentEmit["kind"]>(es: AgentEmit[], k: K) => es.filter((e) => e.kind === k) as Extract<AgentEmit, { kind: K }>[];
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("waitFor timeout");
}

describe("UC5 도구 실행 루프 (계약 §B.6)", () => {
  it("(a) 1-tool 라운드: toolUse→toolResult→재호출→finish, usage 1회·finish 1회", async () => {
    const { handler, emits } = setup();
    await handler.onChatRequest(REQ());
    expect(kinds(emits)).toEqual(["toolUse", "toolResult", "text", "usage", "finish"]);
    expect(pick(emits, "usage").length).toBe(1);
    expect(pick(emits, "finish").length).toBe(1);
    expect(pick(emits, "toolResult")[0].output).toBe("hello-from-tool"); // echo(args.text)
    const u = pick(emits, "usage")[0];
    expect([u.inputTokens, u.outputTokens]).toEqual([5 + 8, 3 + 6]); // 2라운드 스냅샷 합
  });

  it("(b) 미등록 tool → isError toolResult + 복구(finish)", async () => {
    const { handler, emits } = setup({ provider: makeFakeToolProvider({ toolName: "nope" }) });
    await handler.onChatRequest(REQ());
    expect(kinds(emits)).toEqual(["toolUse", "toolResult", "text", "usage", "finish"]);
    expect(pick(emits, "toolResult")[0].output).toMatch(/unknown tool: nope/);
  });

  it("(c)+(g) cap 초과 → error terminal, usage 1회, overflow toolUse 미emit(orphan 없음)", async () => {
    const always: ProviderPort = {
      async *chat(_c, _m, o) {
        if (o.signal?.aborted) return;
        yield { kind: "toolUse", id: "c", name: "echo", args: { text: "x" } };
        yield { kind: "usage", inputTokens: 1, outputTokens: 1 };
        yield { kind: "finish" };
      },
    };
    const { handler, emits } = setup({ provider: always });
    await handler.onChatRequest(REQ());
    const last = emits[emits.length - 1];
    expect(last.kind).toBe("error");
    expect(last.kind === "error" && last.message).toMatch(/tool loop limit/);
    expect(pick(emits, "usage").length).toBe(1);
    expect(pick(emits, "finish").length).toBe(0);
    expect(pick(emits, "toolUse").length).toBe(8); // MAX_TOOL_ROUNDS — overflow 라운드 toolUse 미emit
    expect(pick(emits, "toolResult").length).toBe(8); // 모든 emit 된 toolUse 는 toolResult 와 쌍
  });

  it("(d) 도구 실행 중 취소 → error cancelled, toolResult 미emit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const exec: ToolExecutorPort = {
      specs: () => [{ name: "echo", description: "", parameters: {} }],
      async execute() { await gate; return { output: "late" }; },
    };
    const { handler, emits } = setup({ provider: makeFakeToolProvider(), toolExecutor: exec });
    const p = handler.onChatRequest(REQ());
    await waitFor(() => emits.some((e) => e.kind === "toolUse")); // execute 진입(toolUse 이미 emit)
    handler.onCancel({ kind: "cancel", requestId: "r1" });
    release();
    await p;
    const last = emits[emits.length - 1];
    expect(last.kind).toBe("error");
    expect(last.kind === "error" && last.message).toBe("cancelled");
    expect(emits.some((e) => e.kind === "toolResult")).toBe(false); // 취소로 미emit
    expect(pick(emits, "usage").length).toBe(1); // terminal 직전 1회
  });

  it("(e) executor 미주입 → UC1 순수 채팅(도구 0, 회귀 없음)", async () => {
    const { handler, emits } = setup({ provider: makeFakeProvider("순수응답"), toolExecutor: undefined });
    await handler.onChatRequest(REQ());
    expect(kinds(emits)).toEqual(["text", "usage", "finish"]);
    expect(emits.some((e) => e.kind === "toolUse")).toBe(false);
  });

  it("(f) 같은 라운드 2-call → 두 call 모두 toolUse→toolResult 순서대로 후 재호출", async () => {
    const twoCall: ProviderPort = {
      async *chat(_c, messages, o) {
        if (o.signal?.aborted) return;
        if (!messages.some((m) => m.role === "tool")) {
          yield { kind: "toolUse", id: "c1", name: "echo", args: { text: "one" } };
          yield { kind: "toolUse", id: "c2", name: "echo", args: { text: "two" } };
          yield { kind: "usage", inputTokens: 1, outputTokens: 1 };
          yield { kind: "finish" };
        } else {
          yield { kind: "text", text: "done" };
          yield { kind: "finish" };
        }
      },
    };
    const { handler, emits } = setup({ provider: twoCall });
    await handler.onChatRequest(REQ());
    expect(kinds(emits)).toEqual(["toolUse", "toolResult", "toolUse", "toolResult", "text", "usage", "finish"]);
    const pairSeq = emits.filter((e) => e.kind === "toolUse" || e.kind === "toolResult")
      .map((e) => (e as { toolCallId: string }).toolCallId);
    expect(pairSeq).toEqual(["c1", "c1", "c2", "c2"]); // 순서·결속
    expect(pick(emits, "toolResult").map((e) => e.output)).toEqual(["one", "two"]);
  });
});
