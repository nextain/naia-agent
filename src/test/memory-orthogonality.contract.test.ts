// naia-memory × ChatTurnHandler 직교 UC 통합(Goal2 A) — 살아있는 recall/save 배선을 transport·transcript 와 분리해 검증.
// 직교 3축: memory(recall 주입/save) ⊥ chat(turn 불변식) ⊥ transcript(conversation-log). spawn 없이 fake 포트로 결정론 검증.
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { ConversationLogPort, ConversationTurnRecord } from "../main/ports/conversation-log.js";
import type { ChatRequest, AgentEmit, ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";

/** systemPrompt 캡처 provider — recall 주입 검증용. text→finish 로 턴 정상 종결. */
function capturingProvider() {
  const seen: Array<string | undefined> = [];
  const provider: ProviderPort = {
    // eslint-disable-next-line require-yield
    async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], o: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      seen.push(o.systemPrompt);
      yield { kind: "text", text: "응답" };
      yield { kind: "finish" };
    },
  };
  return { provider, seen };
}

function harness(o: { provider: ProviderPort; memory?: MemoryPort; conversationLog?: ConversationLogPort }) {
  const emits: AgentEmit[] = [];
  const logs: string[] = [];
  const deps: HandlerDeps = {
    provider: o.provider,
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: (m) => logs.push(String(m)) },
    ...(o.memory ? { memory: o.memory } : {}),
    ...(o.conversationLog ? { conversationLog: o.conversationLog } : {}),
  };
  return { deps, emits, logs };
}
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "ollama", model: "gemma4" }, messages: [{ role: "user", content: "hi" }], ...o,
});
const emptyRecall: MemoryPort["recall"] = async () => ({ facts: [], episodes: [] });

describe("naia-memory × ChatTurnHandler 직교 UC 통합 (Goal2 A)", () => {
  it("recall → systemPrompt 주입(회상 content 가 provider 에 도달)", async () => {
    const { provider, seen } = capturingProvider();
    const memory: MemoryPort = { recall: async () => ({ facts: ["RECALL_FACT_ZZZ"], episodes: [] }), save: async () => {} };
    const { deps, emits } = harness({ provider, memory });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    expect(seen[0]).toContain("RECALL_FACT_ZZZ"); // recall→format→inject→provider seam
    expect(seen[0]).toContain("회상된 참고 정보"); // 신뢰경계 프레이밍 보존(FR-MEM-8)
  });

  it("save → 턴 후 (userText, assistantText) 저장", async () => {
    const { provider } = capturingProvider();
    const saved: Array<{ u: string; a: string }> = [];
    const memory: MemoryPort = { recall: emptyRecall, save: async (u, a) => { saved.push({ u, a }); } };
    const { deps } = harness({ provider, memory });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(saved).toHaveLength(1);
    expect(saved[0].u).toBe("hi");
    expect(saved[0].a).toContain("응답");
  });

  it("직교 memory ⊥ chat: recall throw 해도 턴 finish(주입 생략)", async () => {
    const { provider, seen } = capturingProvider();
    const memory: MemoryPort = { recall: async () => { throw new Error("recall down"); }, save: async () => {} };
    const { deps, emits } = harness({ provider, memory });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]); // 회상 실패가 턴 안 깸
    expect(seen[0]).toBeUndefined(); // recall 실패 → 주입 생략(systemPrompt 없음)
  });

  it("직교 memory ⊥ chat: save throw 해도 턴 finish", async () => {
    const { provider } = capturingProvider();
    const memory: MemoryPort = { recall: emptyRecall, save: async () => { throw new Error("save down"); } };
    const { deps, emits } = harness({ provider, memory });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
  });

  it("직교 memory ⊥ transcript: 한 턴에 save·append 가 독립적으로 둘 다 발화", async () => {
    const { provider } = capturingProvider();
    const saved: Array<{ u: string; a: string }> = [];
    const appended: ConversationTurnRecord[] = [];
    const memory: MemoryPort = { recall: emptyRecall, save: async (u, a) => { saved.push({ u, a }); } };
    const conversationLog: ConversationLogPort = { append: async (t) => { appended.push(t); } };
    const { deps } = harness({ provider, memory, conversationLog });
    await new ChatTurnHandler(deps).onChatRequest(req({ sessionId: "s1" }));
    expect(saved).toHaveLength(1); // memory(시맨틱)
    expect(appended).toHaveLength(1); // transcript(verbatim)
    expect(appended[0].sessionId).toBe("s1");
    expect(saved[0].a).toBe(appended[0].assistantText); // 같은 turn 텍스트를 독립 소스로 수신(직교)
  });

  it("memory 미주입 → 무회귀(정상 finish, 주입 없음)", async () => {
    const { provider, seen } = capturingProvider();
    const { deps, emits } = harness({ provider });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    expect(seen[0]).toBeUndefined();
  });
});
