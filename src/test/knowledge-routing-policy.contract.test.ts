import { describe, expect, it } from "vitest";
import {
  ACTION_EXECUTION_POLICY,
  KNOWLEDGE_ROUTING_POLICY,
  ChatTurnHandler,
  type HandlerDeps,
} from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import type { ChatRequest, ToolSpec } from "../main/domain/chat.js";

describe("FR-KB-7 workspace knowledge routing policy", () => {
  function makeHarness(toolSpecs: readonly ToolSpec[] = []) {
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
        specs: () => toolSpecs,
        execute: async () => ({ output: "ok" }),
      },
    };
    return {
      deps,
      getCaptured: () => captured,
    };
  }

  const knowledgeAndOtherSpecs: readonly ToolSpec[] = [
    { name: "skill_knowledge_ask", description: "ask knowledge", parameters: {} },
    { name: "get_weather", description: "weather", parameters: {} },
  ];

  it("appends KNOWLEDGE_ROUTING_POLICY after ACTION_EXECUTION_POLICY when skill_knowledge_ask is registered", async () => {
    const { deps, getCaptured } = makeHarness(knowledgeAndOtherSpecs);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-registered",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "넥스테인 사업에 대해 알려줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain(ACTION_EXECUTION_POLICY);
    expect(captured).toContain(KNOWLEDGE_ROUTING_POLICY);
    expect(captured.indexOf(KNOWLEDGE_ROUTING_POLICY)).toBeGreaterThan(captured.indexOf(ACTION_EXECUTION_POLICY));
    expect(captured).toContain("skill_knowledge_ask and skill_knowledge_search");
    expect(captured).toContain("call skill_knowledge_ask first");
  });

  it("appends KNOWLEDGE_ROUTING_POLICY when systemPrompt override is set", async () => {
    const { deps, getCaptured } = makeHarness(knowledgeAndOtherSpecs);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-override",
      provider: { provider: "fake", model: "m" },
      systemPrompt: "PERSONA",
      messages: [{ role: "user", content: "회사 사업 알려줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain("PERSONA");
    expect(captured).toContain(ACTION_EXECUTION_POLICY);
    expect(captured).toContain(KNOWLEDGE_ROUTING_POLICY);
    expect(captured.indexOf("PERSONA")).toBeLessThan(captured.indexOf(ACTION_EXECUTION_POLICY));
    expect(captured.indexOf(ACTION_EXECUTION_POLICY)).toBeLessThan(captured.indexOf(KNOWLEDGE_ROUTING_POLICY));
  });

  it("does not contain KNOWLEDGE_ROUTING_POLICY when tools are registered but skill_knowledge_ask is absent", async () => {
    const otherSpecs: readonly ToolSpec[] = [
      { name: "get_weather", description: "weather", parameters: {} },
    ];
    const { deps, getCaptured } = makeHarness(otherSpecs);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-no-kb-tool",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "날씨 어때?" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain(ACTION_EXECUTION_POLICY);
    expect(captured).not.toContain(KNOWLEDGE_ROUTING_POLICY);
  });

  it("does not contain KNOWLEDGE_ROUTING_POLICY when enableTools is false even if skill_knowledge_ask is registered", async () => {
    const { deps, getCaptured } = makeHarness(knowledgeAndOtherSpecs);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-tools-disabled",
      provider: { provider: "fake", model: "m" },
      enableTools: false,
      messages: [{ role: "user", content: "넥스테인 사업 알려줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).not.toContain(ACTION_EXECUTION_POLICY);
    expect(captured).not.toContain(KNOWLEDGE_ROUTING_POLICY);
  });
});
