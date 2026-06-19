// conversation-log ↔ ChatTurnHandler 통합(FR-CONV.1) — handler 가 turn-finish 에 conversationLog.append 를 호출하나 +
// sessionId fallback + **no-throw 격리**(append throw 해도 turn finish) + 미주입 무회귀.
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ChatRequest, AgentEmit } from "../main/domain/chat.js";
import type { ConversationLogPort, ConversationTurnRecord } from "../main/ports/conversation-log.js";

function harness(conversationLog?: ConversationLogPort) {
  const emits: AgentEmit[] = [];
  const logs: string[] = [];
  const deps: HandlerDeps = {
    provider: makeFakeProvider(),
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: (m) => logs.push(String(m)) },
    ...(conversationLog ? { conversationLog } : {}),
  };
  return { deps, emits, logs };
}
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat",
  requestId: "r1",
  provider: { provider: "ollama", model: "gemma4" },
  messages: [{ role: "user", content: "hi" }],
  ...o,
});

describe("ChatTurnHandler × ConversationLogPort (FR-CONV.1)", () => {
  it("turn-finish 에 append 1회(sessionId/userText/assistantText) + 정상 종결", async () => {
    const appended: ConversationTurnRecord[] = [];
    const log: ConversationLogPort = { async append(t) { appended.push(t); } };
    const { deps, emits } = harness(log);
    await new ChatTurnHandler(deps).onChatRequest(req({ sessionId: "chat-77" }));
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]); // 턴 불변식 유지
    expect(appended).toHaveLength(1);
    expect(appended[0].sessionId).toBe("chat-77");
    expect(appended[0].userText).toBe("hi");
    expect(appended[0].assistantText.length).toBeGreaterThan(0); // fake provider 응답 누적
  });

  it("sessionId 누락 → 'default' fallback(FR-CONV.2)", async () => {
    const appended: ConversationTurnRecord[] = [];
    const { deps } = harness({ async append(t) { appended.push(t); } });
    await new ChatTurnHandler(deps).onChatRequest(req()); // sessionId 없음
    expect(appended[0].sessionId).toBe("default");
  });

  it("no-throw 격리: append throw 해도 turn 은 finish(FR-CONV.1)", async () => {
    const { deps, emits, logs } = harness({ async append() { throw new Error("disk full"); } });
    await new ChatTurnHandler(deps).onChatRequest(req({ sessionId: "s" }));
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]); // append 실패가 finish 무영향
    expect(logs.some((l) => l.includes("transcript"))).toBe(true); // 진단 로그 남김(흡수)
  });

  it("conversationLog 미주입 → 무회귀(정상 finish)", async () => {
    const { deps, emits } = harness(); // conversationLog 없음
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
  });
});
