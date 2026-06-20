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
      m("assistant", "", { toolCalls: [{ id: "c1", name: "t", args: {} }] as unknown as ChatMessage["toolCalls"] }),
      m("tool", big, { toolCallId: "c1" }),
      m("user", "final"),
    ];
    const out = conv.assemble({ messages });
    expect(out.messages[0]!.role).not.toBe("tool"); // 선두 고아 tool 없음
    expect(out.messages[out.messages.length - 1]!.content).toBe("final");
  });

  // codex 적대리뷰 보강: tool 라운드 원자성 + toolCalls payload 예산 계산
  it("최신 tool 라운드(assistant+tool)는 예산이 빠듯해도 원자적으로 함께 보존한다(고아 tool 단독 금지)", () => {
    const conv = makeBudgetedConversation({ maxTokens: 1 }); // 4자 예산 — 단독 tool 보존 유혹 상황
    const messages: ChatMessage[] = [
      m("assistant", "", { toolCalls: [{ id: "c1", name: "t", args: {} }] as unknown as ChatMessage["toolCalls"] }),
      m("tool", "결과", { toolCallId: "c1" }),
    ];
    const out = conv.assemble({ messages });
    expect(out.messages).toHaveLength(2); // 둘 다 보존 — assistant 없는 고아 tool 금지
    expect(out.messages[0]!.role).toBe("assistant");
  });

  it("assistant.toolCalls payload(거대 args)도 예산에 계산되어 절단을 유발한다", () => {
    const conv = makeBudgetedConversation({ maxTokens: 100 }); // ≈400자
    const hugeArgs = "q".repeat(2000); // content 가 아닌 toolCalls 안에 큰 payload
    const messages: ChatMessage[] = [
      m("assistant", "", { toolCalls: [{ id: "c1", name: "search", args: hugeArgs }] as unknown as ChatMessage["toolCalls"] }),
      m("tool", "ok", { toolCallId: "c1" }),
      m("user", "최신질문"),
    ];
    const out = conv.assemble({ messages });
    // payload 를 계산하지 않으면 라운드가 예산에 들어와 length 3 이 됨 → 1 이어야 정상(절단)
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.content).toBe("최신질문");
  });
});
