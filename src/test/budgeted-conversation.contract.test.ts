import { describe, it, expect } from "vitest";
import { makeBudgetedConversation } from "../main/adapters/budgeted-conversation.js";
import type { ChatMessage } from "../main/domain/chat.js";

// @spec SPEC-007  (REQ-009 / UC-012 — 토큰예산 대화 압축)
const m = (role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage =>
  ({ role, content, ...extra });

describe("budgeted-conversation (SPEC-007) — 토큰예산 대화 조립", () => {
  it("예산 이내(짧은 대화)면 메시지를 그대로 두고 systemPrompt 를 보존한다", () => {
    const conv = makeBudgetedConversation({ maxTokens: 1000 });
    const messages = [m("user", "안녕"), m("assistant", "반가워요"), m("user", "오늘 어때")];
    const out = conv.assemble({ messages, systemPrompt: "친절하게" });
    expect(out.messages).toHaveLength(3);
    expect(out.systemPrompt).toBe("친절하게");
  });

  it("예산 초과면 오래된 메시지를 절단하고 최신을 유지한다", () => {
    const conv = makeBudgetedConversation({ maxTokens: 100 }); // ≈400자 예산
    const big = "x".repeat(200);
    const out = conv.assemble({ messages: [m("user", big), m("assistant", big), m("user", "최신")] });
    expect(out.messages.length).toBeLessThan(3); // 오래된 것 절단됨
    expect(out.messages[out.messages.length - 1]!.content).toBe("최신"); // 최신 보존
  });

  it("최신 메시지 하나가 예산을 초과해도 그 메시지는 항상 유지한다", () => {
    const conv = makeBudgetedConversation({ maxTokens: 1 });
    const huge = "y".repeat(10000);
    const out = conv.assemble({ messages: [m("user", "옛것"), m("user", huge)] });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe(huge);
  });

  it("systemPrompt 는 항상 보존되며 예산에 함께 계산된다", () => {
    const conv = makeBudgetedConversation({ maxTokens: 100 });
    const out = conv.assemble({ messages: [m("user", "a"), m("user", "b")], systemPrompt: "sys" });
    expect(out.systemPrompt).toBe("sys");
  });

  it("절단 후 선두에 고아 tool 결과(앞선 assistant 라운드가 잘린)를 남기지 않는다", () => {
    const conv = makeBudgetedConversation({ maxTokens: 30 }); // 작게 → tool 라운드 중간으로 절단 유도
    const big = "z".repeat(80);
    const messages: ChatMessage[] = [
      m("user", big),
      m("assistant", "", { toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] as unknown as ChatMessage["toolCalls"] }),
      m("tool", big, { toolCallId: "c1" }),
      m("user", "final"),
    ];
    const out = conv.assemble({ messages });
    expect(out.messages[0]!.role).not.toBe("tool"); // 선두 고아 tool 없음
    expect(out.messages[out.messages.length - 1]!.content).toBe("final");
  });
});
