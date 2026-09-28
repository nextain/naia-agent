import { describe, expect, it, vi } from "vitest";
import {
  ACTION_EXECUTION_POLICY,
  KNOWLEDGE_ROUTING_POLICY,
  ChatTurnHandler,
  type HandlerDeps,
} from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import type { ChatRequest, ToolSpec } from "../main/domain/chat.js";
import type { ProcessingGuardPort } from "../main/ports/uc1.js";

describe("FR-KB-7 workspace knowledge routing policy", () => {
  function makeHarness(
    toolSpecs: readonly ToolSpec[] = [],
    memory?: HandlerDeps["memory"],
    extraDeps?: Partial<HandlerDeps>,
  ) {
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
      egress: { emit: () => {}, emitCritical: () => true },
      diag: { log: () => {} },
      toolExecutor: {
        specs: () => toolSpecs,
        execute: async () => ({ output: "ok" }),
      },
      ...(memory ? { memory } : {}),
      ...(extraDeps ?? {}),
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

  it("contains skill_knowledge_scope and anti-hallucination clause when skill_knowledge_ask is registered", async () => {
    const { deps, getCaptured } = makeHarness(knowledgeAndOtherSpecs);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-scope-test",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "지식 파일은 뭐가 있어?" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain("skill_knowledge_scope");
    expect(captured).toContain("Never claim that other files");
  });

  it("does not contain memo_save guidance in KNOWLEDGE_ROUTING_POLICY itself or when memo_save is absent", async () => {
    expect(KNOWLEDGE_ROUTING_POLICY).not.toContain("Call memo_save ONLY on an explicit memo request");

    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps, getCaptured } = makeHarness(knowledgeAndOtherSpecs, memory);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-no-memo-tool",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain(KNOWLEDGE_ROUTING_POLICY);
    expect(captured).not.toContain("Call memo_save ONLY on an explicit memo request");
    expect(save).toHaveBeenCalledOnce();
  });

  it("injects memo guidance when memo_save is offered without skill_knowledge_ask", async () => {
    const memoOnlySpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
      { name: "get_weather", description: "weather", parameters: {} },
    ];
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps, getCaptured } = makeHarness(memoOnlySpecs, memory);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-without-kb",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).not.toContain(KNOWLEDGE_ROUTING_POLICY);
    expect(captured).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    expect(captured).toContain("say it will be remembered if memory saving is allowed");
    expect(save).toHaveBeenCalledOnce();
  });

  it("asserts memory-on prompt variant and memory.save called for eligible turns", async () => {
    const memoSpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
    ];
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps, getCaptured } = makeHarness(memoSpecs, memory);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-mem-on",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    expect(captured).toContain("For pure \"기억해줘\" or \"remember this\"-style requests, do not call memo_save; say it will be remembered if memory saving is allowed.");
    expect(captured).not.toContain("long-term memory is off");
    expect(save).toHaveBeenCalledOnce();
  });

  it("asserts memo-off prompt variant and memory.save not called for memory-off and Discord turns", async () => {
    const memoSpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
    ];

    // Case 1: memory-off (deps.memory not wired)
    const { deps: memOffDeps, getCaptured: getMemOffCaptured } = makeHarness(memoSpecs);
    const memOffRequest: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-mem-off",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };
    await new ChatTurnHandler(memOffDeps).onChatRequest(memOffRequest);
    const memOffCaptured = getMemOffCaptured();
    expect(memOffCaptured).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    expect(memOffCaptured).toContain("long-term memory is off for this conversation; do not claim it is remembered; tell the user.");
    expect(memOffCaptured).not.toContain("say it will be remembered");

    // Case 2: Discord turn (channel.kind === 'discord', even with memory wired)
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps: discordDeps, getCaptured: getDiscordCaptured } = makeHarness(memoSpecs, memory);
    const discordRequest: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-discord",
      provider: { provider: "fake", model: "m" },
      channel: { kind: "discord", bindingId: "b-1", guildId: "g-1", channelId: "ch-1", userId: "u-1" },
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };
    await new ChatTurnHandler(discordDeps).onChatRequest(discordRequest);
    const discordCaptured = getDiscordCaptured();
    expect(discordCaptured).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    expect(discordCaptured).toContain("long-term memory is off for this conversation; do not claim it is remembered; tell the user.");
    expect(discordCaptured).not.toContain("say it will be remembered");
    expect(save).not.toHaveBeenCalled();
  });

  it("asserts memory-on prompt variant but memory.save skipped when processing auth denies save", async () => {
    const memoSpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
    ];
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const processingGuard: ProcessingGuardPort = {
      authorize: (input) => ({
        workload: input.workload,
        destination: "external_cloud",
        decision: input.workload === "memory_llm" ? "blocked" : "allowed",
        processingProfileRef: input.processingProfileRef,
      }),
      authorizePlan: (inputs) => inputs.map((input) => ({
        workload: input.workload,
        destination: "external_cloud",
        decision: input.workload === "memory_llm" ? "blocked" : "allowed",
        processingProfileRef: input.processingProfileRef,
      })),
      preparePlan: (inputs) => ({
        disclosures: inputs.map((input) => ({
          workload: input.workload,
          destination: "external_cloud",
          decision: input.workload === "memory_llm" ? "blocked" : "allowed",
          processingProfileRef: input.processingProfileRef,
        })),
        commit: () => true,
        rollback: () => true,
      }),
    };
    const { deps, getCaptured } = makeHarness(memoSpecs, memory, { processingGuard });
    const request: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-processing-deny",
      provider: { provider: "fake", model: "m" },
      processing: { processingProfileRef: "profile-1" },
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    expect(captured).toContain("say it will be remembered if memory saving is allowed");
    expect(captured).not.toContain("long-term memory is off");
    expect(save).not.toHaveBeenCalled();
  });

  it("asserts memo-off prompt variant and memory.save not called when last message is not from user", async () => {
    const memoSpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
    ];
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps, getCaptured } = makeHarness(memoSpecs, memory);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-last-msg-assistant",
      provider: { provider: "fake", model: "m" },
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).toContain("Call memo_save ONLY on an explicit memo request; if the user explicitly asks for a memo, call memo_save.");
    expect(captured).toContain("long-term memory is off for this conversation; do not claim it is remembered; tell the user.");
    expect(captured).not.toContain("say it will be remembered");
    expect(save).not.toHaveBeenCalled();
  });

  it("omits memo policy but keeps memory.save active when enableTools is false", async () => {
    const memoSpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
    ];
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps, getCaptured } = makeHarness(memoSpecs, memory);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-tools-disabled",
      provider: { provider: "fake", model: "m" },
      enableTools: false,
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).not.toContain("Memo tools policy:");
    expect(save).toHaveBeenCalledOnce();
  });

  it("omits memo policy but keeps memory.save active when memo_save is in disabledSkills", async () => {
    const memoSpecs: readonly ToolSpec[] = [
      { name: "memo_save", description: "save memo", parameters: {} },
    ];
    const save = vi.fn(async () => {});
    const memory = { recall: async () => ({ facts: [], episodes: [] }), save };
    const { deps, getCaptured } = makeHarness(memoSpecs, memory);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "memo-guidance-skill-disabled",
      provider: { provider: "fake", model: "m" },
      disabledSkills: ["memo_save"],
      messages: [{ role: "user", content: "이거 기억해줘" }],
    };

    await new ChatTurnHandler(deps).onChatRequest(request);

    const captured = getCaptured();
    expect(captured).not.toContain("Memo tools policy:");
    expect(save).toHaveBeenCalledOnce();
  });

  it("includes stored-rule knowledge routing and exact value quotation guidance (#155)", async () => {
    expect(KNOWLEDGE_ROUTING_POLICY).toContain(
      "- A question about a rule, policy, procedure, schedule, decision or other fact the user stored as knowledge (for example \"배포 규칙이 뭐였지?\") is a knowledge question: call skill_knowledge_ask or skill_knowledge_search in this turn before reading any workspace file, and never answer it from AGENTS.md or other workspace files instead of the knowledge tools.",
    );
    expect(KNOWLEDGE_ROUTING_POLICY).toContain(
      "- When a knowledge or memory result contains concrete values such as numbers, times (for example 0045), dates, names or codes, repeat each value exactly as written in your answer; never replace it with a paraphrase such as \"late at night\". If results give different values, list every value with its source.",
    );

    const { deps, getCaptured } = makeHarness(knowledgeAndOtherSpecs);
    const request: ChatRequest = {
      kind: "chat",
      requestId: "kb-policy-rule-question",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "배포 규칙이 뭐였지?" }],
    };
    await new ChatTurnHandler(deps).onChatRequest(request);
    const captured = getCaptured();
    expect(captured).toContain("배포 규칙이 뭐였지?");
    expect(captured).toContain("repeat each value exactly as written in your answer");
  });
});

