import { describe, expect, it } from "vitest";
import { ACTION_EXECUTION_POLICY, ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import type { ChatRequest } from "../main/domain/chat.js";

describe("FR-ACTION-1 same-turn execution policy", () => {
  it("appends the policy even when a caller supplies a persona override", async () => {
    let captured = "";
    const conversation: HandlerDeps["conversation"] = {
      assemble(input) {
        captured = input.systemPrompt ?? "";
        return { messages: input.messages, systemPrompt: input.systemPrompt };
      },
    };
    const deps: HandlerDeps = {
      provider: makeFakeProvider("done"),
      conversation,
      credentials: { update: () => {}, get: () => undefined },
      approval: makeInMemoryApproval(),
      egress: { emit: () => {} },
      diag: { log: () => {} },
      toolExecutor: {
        specs: () => [{ name: "get_weather", description: "weather", parameters: {} }],
        execute: async () => ({ output: "sunny" }),
      },
    };
    const request: ChatRequest = {
      kind: "chat",
      requestId: "action-policy",
      provider: { provider: "fake", model: "m" },
      systemPrompt: "PERSONA",
      messages: [{ role: "user", content: "서울 날씨 알려줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    expect(captured).toContain("PERSONA");
    expect(captured).toContain(ACTION_EXECUTION_POLICY);
    expect(captured).toContain("call the relevant tool in this turn");
    expect(captured).toContain("vague background-music request");
    expect(captured).toContain("private reasoning");
  });
});
