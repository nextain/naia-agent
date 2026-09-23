import { describe, expect, it, vi } from "vitest";
import { ChatTurnHandler, type HandlerDeps, MEMORY_TOOL_POLICY, KNOWLEDGE_ROUTING_POLICY } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import type { SurfacingPort } from "../main/ports/surfacing.js";
import type { MemoryPort } from "../main/ports/memory.js";
import { MEMORY_INDEX_UNAVAILABLE_NOTICE, type RecalledMemory } from "../main/domain/memory.js";
import type {
  AgentEmit,
  ChatMessage,
  ChatRequest,
  ProviderChunk,
  ProviderConfig,
} from "../main/domain/chat.js";
import type { ProcessingGuardPort, ProviderChatOpts, ProviderPort, ToolExecutorPort } from "../main/ports/uc1.js";

describe("ChatTurnHandler memory surfacing integration contract tests", () => {
  const allowAllProcessingGuard: ProcessingGuardPort = {
    authorize: (input) => ({
      kind: "processingDisclosure" as const,
      workload: input.workload,
      destination: "local_device" as const,
      decision: "allowed" as const,
      processingProfileRef: input.processingProfileRef,
      provider: input.provider.provider,
      model: input.provider.model,
    }),
    authorizePlan: (inputs) =>
      inputs.map((inp) => ({
        kind: "processingDisclosure" as const,
        workload: inp.workload,
        destination: "local_device" as const,
        decision: "allowed" as const,
        processingProfileRef: inp.processingProfileRef,
        provider: inp.provider.provider,
        model: inp.provider.model,
      })),
    preparePlan: (inputs) => ({
      disclosures: inputs.map((inp) => ({
        kind: "processingDisclosure" as const,
        workload: inp.workload,
        destination: "local_device" as const,
        decision: "allowed" as const,
        processingProfileRef: inp.processingProfileRef,
        provider: inp.provider.provider,
        model: inp.provider.model,
      })),
      commit: () => true,
      rollback: () => true,
    }),
  };

  function makeHarness(opts: {
    surfacer?: SurfacingPort;
    recalledMemory?: RecalledMemory;
    memory?: MemoryPort;
    processingGuard?: ProcessingGuardPort;
  }) {
    const seenSystemPrompts: string[] = [];
    const emits: AgentEmit[] = [];

    const provider: ProviderPort = {
      async *chat(
        _c: ProviderConfig,
        _m: readonly ChatMessage[],
        o: ProviderChatOpts,
      ): AsyncIterable<ProviderChunk> {
        seenSystemPrompts.push(o.systemPrompt ?? "");
        yield { kind: "text", text: "답변입니다." };
        yield { kind: "finish" };
      },
    };

    const memory: MemoryPort = opts.memory ?? {
      recall: vi.fn(async () =>
        opts.recalledMemory ?? {
          facts: ["기억 항목 A", "기억 항목 B"],
          factScores: [0.9, 0.91],
          episodes: [],
        },
      ),
      save: vi.fn(async () => {}),
    };

    const deps: HandlerDeps = {
      defaultConfig: { provider: "fake", model: "m" },
      provider,
      conversation: {
        assemble: (req) => ({ messages: req.messages, systemPrompt: req.systemPrompt }),
      },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: {
        emit: (_id, e) => emits.push(e),
        emitCritical: async () => true,
      },
      diag: { log: () => {} },
      memory,
      ...(opts.surfacer ? { surfacer: opts.surfacer } : {}),
      ...(opts.processingGuard ? { processingGuard: opts.processingGuard } : {}),
    };

    return {
      handler: new ChatTurnHandler(deps),
      seenSystemPrompts,
      emits,
      memory,
    };
  }

  it("no surfacer → system prompt contains [회상된 참고 정보 — 시작] block with all recalled items", async () => {
    const { handler, seenSystemPrompts } = makeHarness({});
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r1",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    expect(seenSystemPrompts.length).toBe(1);
    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("[회상된 참고 정보 — 시작]");
    expect(prompt).toContain("기억 항목 A");
    expect(prompt).toContain("기억 항목 B");
    expect(prompt).not.toContain("[문득 떠오른 기억·지식");
  });

  it("ready snapshot with block and judgedKeys = key of item A → surfaced before recall, excludes item A, keeps item B", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => ({
        block: "[문득 떠오른 기억·지식 — 시작]\n- (기억 · 사용자가 말함) 떠오른 기억\n[문득 떠오른 기억·지식 — 끝]",
        judgedKeys: new Set(["사용자는 부산에서 태어났다"]),
        surfacedCount: 1,
      })),
      schedule: vi.fn(),
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const { handler, seenSystemPrompts } = makeHarness({
      surfacer: fakeSurfacer,
      recalledMemory: {
        facts: ["사용자는 부산에서 태어났다", "사용자는 밀면을 가장 좋아한다"],
        factScores: [0.9, 0.91],
        episodes: [],
      },
    });
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r2",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("[문득 떠오른 기억·지식 — 시작]");
    expect(prompt).toContain("[회상된 참고 정보 — 시작]");
    expect(prompt.indexOf("[문득 떠오른 기억·지식")).toBeLessThan(prompt.indexOf("[회상된 참고 정보"));
    expect(prompt).not.toContain("사용자는 부산에서 태어났다");
    expect(prompt).toContain("사용자는 밀면을 가장 좋아한다");
  });

  it("ready snapshot with block '' and all recalled items judged → prompt contains neither block", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => ({
        block: "",
        judgedKeys: new Set(["기억 항목 A", "기억 항목 B"]),
        surfacedCount: 0,
      })),
      schedule: vi.fn(),
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const { handler, seenSystemPrompts } = makeHarness({ surfacer: fakeSurfacer });
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r3",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    const prompt = seenSystemPrompts[0];
    expect(prompt).not.toContain("[문득 떠오른 기억·지식");
    expect(prompt).not.toContain("[회상된 참고 정보");
  });

  it("consume returns undefined → prompt contains the scored recalled items", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => undefined),
      schedule: vi.fn(),
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const { handler, seenSystemPrompts } = makeHarness({
      surfacer: fakeSurfacer,
      recalledMemory: {
        facts: ["사용자는 부산에서 태어났다", "사용자는 밀면을 가장 좋아한다"],
        factScores: [0.9, 0.91],
        episodes: [],
      },
    });
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r4",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("[회상된 참고 정보 — 시작]");
    expect(prompt).toContain("사용자는 부산에서 태어났다");
    expect(prompt).toContain("사용자는 밀면을 가장 좋아한다");
    expect(prompt).not.toContain("[문득 떠오른 기억·지식");
  });

  it("schedule is called once with sessionId from req.sessionId (and 'default' when absent) and turns ending with assistant reply", async () => {
    const scheduleMock = vi.fn();
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => undefined),
      schedule: scheduleMock,
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const { handler } = makeHarness({ surfacer: fakeSurfacer });

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r5-sess",
      sessionId: "my-session-42",
      messages: [{ role: "user", content: "첫 번째 질문" }],
    });

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith({
      sessionId: "my-session-42",
      turns: [
        { role: "user", content: "첫 번째 질문" },
        { role: "assistant", content: "답변입니다." },
      ],
    });

    scheduleMock.mockClear();
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r5-default",
      messages: [{ role: "user", content: "두 번째 질문" }],
    });

    expect(scheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "default" }),
    );
  });

  it("discord channel → consume and schedule not called", async () => {
    const consumeMock = vi.fn();
    const scheduleMock = vi.fn();
    const fakeSurfacer: SurfacingPort = {
      consume: consumeMock,
      schedule: scheduleMock,
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const { handler } = makeHarness({ surfacer: fakeSurfacer });

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r6-discord",
      channel: { kind: "discord", bindingId: "b1", guildId: "g1", channelId: "c1", userId: "u1" },
      messages: [{ role: "user", content: "디스코드 발화" }],
    });

    expect(consumeMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("consume throws or schedule throws → turn still finishes normally, no error event", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => {
        throw new Error("consume exploded");
      }),
      schedule: vi.fn(() => {
        throw new Error("schedule exploded");
      }),
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const { handler, emits } = makeHarness({ surfacer: fakeSurfacer });

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r7",
      messages: [{ role: "user", content: "안녕" }],
    });

    expect(emits.some((e) => e.kind === "finish")).toBe(true);
    expect(emits.some((e) => e.kind === "error")).toBe(false);
  });

  it("memory recall rejects with MEMORY_PREPARING while ready snapshot exists → prompt contains surfaced block and notice in order", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => ({
        block: "[문득 떠오른 기억·지식 — 시작]\n- (기억 · 사용자가 말함) 떠오른 기억\n[문득 떠오른 기억·지식 — 끝]",
        judgedKeys: new Set(["기억 항목 A"]),
        surfacedCount: 1,
      })),
      schedule: vi.fn(),
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const failingMemory: MemoryPort = {
      recall: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "MEMORY_PREPARING" });
      }),
      save: vi.fn(async () => {}),
    };
    const { handler, seenSystemPrompts } = makeHarness({
      surfacer: fakeSurfacer,
      memory: failingMemory,
    });
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r8-prep",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    expect(seenSystemPrompts.length).toBe(1);
    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("[문득 떠오른 기억·지식 — 시작]");
    expect(prompt).toContain(MEMORY_INDEX_UNAVAILABLE_NOTICE);
    const surfacedIdx = prompt.indexOf("[문득 떠오른 기억·지식 — 시작]");
    const noticeIdx = prompt.indexOf(MEMORY_INDEX_UNAVAILABLE_NOTICE);
    expect(surfacedIdx).toBeLessThan(noticeIdx);
  });

  it("surfacer mode 'off' → does not call memory.recall and no [회상된 참고 정보] in prompt", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(),
      schedule: vi.fn(),
      mode: () => "off",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const recallMock = vi.fn(async () => ({ facts: ["기억 1"], episodes: [] }));
    const { handler, seenSystemPrompts } = makeHarness({
      surfacer: fakeSurfacer,
      memory: { recall: recallMock, save: vi.fn(async () => {}) },
    });
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r-off",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    expect(recallMock).not.toHaveBeenCalled();
    expect(seenSystemPrompts.length).toBe(1);
    expect(seenSystemPrompts[0]).not.toContain("[회상된 참고 정보");
    expect(seenSystemPrompts[0]).not.toContain("[문득 떠오른 기억·지식");
  });

  it("surfacer mode 'on-threshold' → calls recall with touch:false, filters by threshold, logs numerical stats, no schedule on finish", async () => {
    const diagLogs: Array<{ msg: string; ctx: any }> = [];
    const scheduleMock = vi.fn();
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(),
      schedule: scheduleMock,
      mode: () => "on-threshold",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const recallMock = vi.fn(async (_q: string, _opts?: any) => ({
      facts: ["높은 점수 사실", "낮은 점수 사실"],
      factScores: [0.92, 0.75],
      episodes: [
        { role: "user" as const, content: "에피소드 통과", score: 0.88 },
        { role: "assistant" as const, content: "에피소드 탈락", score: 0.5 },
      ],
    }));

    const seenSystemPrompts: string[] = [];
    const emits: AgentEmit[] = [];
    const provider: ProviderPort = {
      async *chat(_c, _m, o): AsyncIterable<ProviderChunk> {
        seenSystemPrompts.push(o.systemPrompt ?? "");
        yield { kind: "text", text: "답변입니다." };
        yield { kind: "finish" };
      },
    };
    const deps: HandlerDeps = {
      defaultConfig: { provider: "fake", model: "m" },
      provider,
      conversation: {
        assemble: (req) => ({ messages: req.messages, systemPrompt: req.systemPrompt }),
      },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: (_id, e) => emits.push(e) },
      diag: { log: (msg, ctx) => diagLogs.push({ msg, ctx }) },
      memory: { recall: recallMock, save: vi.fn(async () => {}) },
      surfacer: fakeSurfacer,
    };

    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-threshold",
      messages: [{ role: "user", content: "질문입니다" }],
    });

    // 1. recall options
    expect(recallMock).toHaveBeenCalledWith("질문입니다", { touch: false, topK: 20 });

    // 2. prompt filtered
    expect(seenSystemPrompts.length).toBe(1);
    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("높은 점수 사실");
    expect(prompt).not.toContain("낮은 점수 사실");
    expect(prompt).toContain("에피소드 통과");
    expect(prompt).not.toContain("에피소드 탈락");

    // 3. numerical stats logged without text/query
    const statLog = diagLogs.find((l) => l.msg === "memory surfacing applied");
    expect(statLog).toBeDefined();
    expect(statLog!.ctx).toEqual({
      mode: "on-threshold",
      threshold: 0.86,
      candidates: 4,
      kept: 2,
      missingScore: 0,
      trivial: 0,
      below: 2,
      keptScores: [0.92, 0.88],
      nearMissScores: [0.75, 0.5],
      snapshot: null,
    });
    const ctxStr = JSON.stringify(statLog!.ctx);
    expect(ctxStr).not.toContain("사실");
    expect(ctxStr).not.toContain("질문입니다");

    // 4. schedule was NOT called for on-threshold
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("offered-tool guard rejects unadvertised skill_memory_recall on discord or processing request", async () => {
    let callIndex = 0;
    const provider: ProviderPort = {
      async *chat(_c, _m, _o): AsyncIterable<ProviderChunk> {
        callIndex++;
        if (callIndex === 1) {
          yield {
            kind: "toolUse",
            id: "call_mem_1",
            name: "skill_memory_recall",
            args: { query: "비밀" },
          };
          yield { kind: "finish" };
        } else {
          yield { kind: "text", text: "도구 거부 후 최종 응답" };
          yield { kind: "finish" };
        }
      },
    };

    const emits: AgentEmit[] = [];
    const toolExecutor: ToolExecutorPort = {
      specs: () => [
        { name: "skill_memory_recall", description: "recall", parameters: { type: "object" } },
      ],
      execute: vi.fn(),
    };

    const deps: HandlerDeps = {
      defaultConfig: { provider: "fake", model: "m" },
      provider,
      conversation: {
        assemble: (req) => ({ messages: req.messages, systemPrompt: req.systemPrompt }),
      },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: (_id, e) => emits.push(e) },
      diag: { log: () => {} },
      memory: { recall: vi.fn(async () => ({ facts: [], episodes: [] })), save: vi.fn(async () => {}) },
      toolExecutor,
      processingGuard: allowAllProcessingGuard,
    };
    const handler = new ChatTurnHandler(deps);

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-guard-discord",
      channel: { kind: "discord", bindingId: "b1", guildId: "g1", channelId: "c1", userId: "u1" },
      messages: [{ role: "user", content: "디스코드 발화" }],
    });

    const toolUse = emits.find((e) => e.kind === "toolUse" && e.toolName === "skill_memory_recall");
    const toolResult = emits.find((e) => e.kind === "toolResult" && e.toolName === "skill_memory_recall");
    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.kind === "toolResult") {
      expect(toolResult.success).toBe(false);
      expect(toolResult.output).toContain("tool 'skill_memory_recall' is not available in this conversation");
    }
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("on-threshold with all scores missing → no [회상된 참고 정보] block at all (fail closed)", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(),
      schedule: vi.fn(),
      mode: () => "on-threshold",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const recallMock = vi.fn(async () => ({
      facts: ["점수 없는 사실 1", "점수 없는 사실 2"],
      episodes: [
        { role: "user" as const, content: "점수 없는 에피소드" },
      ],
    }));
    const { handler, seenSystemPrompts } = makeHarness({
      surfacer: fakeSurfacer,
      memory: { recall: recallMock, save: vi.fn(async () => {}) },
    });

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-missing-scores",
      messages: [{ role: "user", content: "질문" }],
    });

    expect(seenSystemPrompts.length).toBe(1);
    expect(seenSystemPrompts[0]).not.toContain("[회상된 참고 정보");
  });

  it("on-llm: snapshot block injected; recall block only has unjudged items above threshold", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => ({
        block: "[문득 떠오른 기억·지식 — 시작]\n- (기억 · 사용자가 말함) 떠오른 기억\n[문득 떠오른 기억·지식 — 끝]",
        judgedKeys: new Set(["판단된 사실"]),
        surfacedCount: 1,
      })),
      schedule: vi.fn(),
      mode: () => "on-llm",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const recallMock = vi.fn(async () => ({
      facts: ["판단된 사실", "미판단 높은점수 사실", "미판단 낮은점수 사실"],
      factScores: [0.95, 0.90, 0.70],
      episodes: [],
    }));
    const { handler, seenSystemPrompts } = makeHarness({
      surfacer: fakeSurfacer,
      memory: { recall: recallMock, save: vi.fn(async () => {}) },
    });

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-on-llm-threshold",
      messages: [{ role: "user", content: "질문" }],
    });

    expect(seenSystemPrompts.length).toBe(1);
    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("[문득 떠오른 기억·지식 — 시작]");
    expect(prompt).toContain("떠오른 기억");
    expect(prompt).toContain("[회상된 참고 정보 — 시작]");
    expect(prompt).not.toContain("판단된 사실");
    expect(prompt).toContain("미판단 높은점수 사실");
    expect(prompt).not.toContain("미판단 낮은점수 사실");
  });

  it("tool exclusion: skill_memory_recall and MEMORY_TOOL_POLICY omitted on discord / processing request, present on normal request; disabledSkills: ['skill_knowledge_ask'] omits KNOWLEDGE_ROUTING_POLICY", async () => {
    const capturedPrompts: string[] = [];
    const capturedToolSpecs: Array<readonly any[]> = [];

    const provider: ProviderPort = {
      async *chat(_c, _m, o): AsyncIterable<ProviderChunk> {
        capturedPrompts.push(o.systemPrompt ?? "");
        capturedToolSpecs.push(o.tools ?? []);
        yield { kind: "text", text: "답변" };
        yield { kind: "finish" };
      },
    };

    const toolExecutor: ToolExecutorPort = {
      specs: () => [
        { name: "skill_memory_recall", description: "recall", parameters: { type: "object" } },
        { name: "skill_knowledge_ask", description: "knowledge", parameters: { type: "object" } },
      ],
      execute: vi.fn(),
    };

    const deps: HandlerDeps = {
      defaultConfig: { provider: "fake", model: "m" },
      provider,
      conversation: { assemble: (req) => ({ messages: req.messages, systemPrompt: req.systemPrompt }) },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: () => {}, emitCritical: async () => true },
      diag: { log: () => {} },
      memory: { recall: vi.fn(async () => ({ facts: [], episodes: [] })), save: vi.fn(async () => {}) },
      toolExecutor,
      processingGuard: allowAllProcessingGuard,
    };
    const handler = new ChatTurnHandler(deps);

    // 1. Normal desktop request -> both tools and policies present
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-normal",
      messages: [{ role: "user", content: "질문 1" }],
    });
    expect(capturedToolSpecs[0].map((t) => t.name)).toContain("skill_memory_recall");
    expect(capturedToolSpecs[0].map((t) => t.name)).toContain("skill_knowledge_ask");
    expect(capturedPrompts[0]).toContain(MEMORY_TOOL_POLICY);
    expect(capturedPrompts[0]).toContain(KNOWLEDGE_ROUTING_POLICY);

    // 2. Discord request -> privatePersistenceAllowed is false -> skill_memory_recall & MEMORY_TOOL_POLICY omitted
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-discord",
      channel: { kind: "discord", bindingId: "b1", guildId: "g1", channelId: "c1", userId: "u1" },
      messages: [{ role: "user", content: "디스코드 발화" }],
    });
    expect(capturedToolSpecs[1].map((t) => t.name)).not.toContain("skill_memory_recall");
    expect(capturedToolSpecs[1].map((t) => t.name)).toContain("skill_knowledge_ask");
    expect(capturedPrompts[1]).not.toContain(MEMORY_TOOL_POLICY);
    expect(capturedPrompts[1]).toContain(KNOWLEDGE_ROUTING_POLICY);

    // 3. Processing request -> skill_memory_recall & MEMORY_TOOL_POLICY omitted
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-processing",
      processing: { processingProfileRef: "profile_1" },
      messages: [{ role: "user", content: "백그라운드 처리" }],
    });
    expect(capturedToolSpecs[2].map((t) => t.name)).not.toContain("skill_memory_recall");
    expect(capturedPrompts[2]).not.toContain(MEMORY_TOOL_POLICY);

    // 4. disabledSkills: ["skill_knowledge_ask"] -> KNOWLEDGE_ROUTING_POLICY omitted
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-disabled-skill",
      disabledSkills: ["skill_knowledge_ask"],
      messages: [{ role: "user", content: "지식 비활성화 질문" }],
    });
    expect(capturedToolSpecs[3].map((t) => t.name)).toContain("skill_memory_recall");
    expect(capturedToolSpecs[3].map((t) => t.name)).not.toContain("skill_knowledge_ask");
    expect(capturedPrompts[3]).toContain(MEMORY_TOOL_POLICY);
    expect(capturedPrompts[3]).not.toContain(KNOWLEDGE_ROUTING_POLICY);
  });

  it("surfacer whose mode() throws → turn finishes normally, no recall block, memory.recall not called", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(),
      schedule: vi.fn(),
      mode: () => {
        throw new Error("mode failure");
      },
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const recallMock = vi.fn(async () => ({ facts: ["기억 1"], episodes: [] }));
    const { handler, seenSystemPrompts, emits } = makeHarness({
      surfacer: fakeSurfacer,
      memory: { recall: recallMock, save: vi.fn(async () => {}) },
    });
    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-mode-throw",
      messages: [{ role: "user", content: "안녕" }],
    });

    expect(recallMock).not.toHaveBeenCalled();
    expect(seenSystemPrompts.length).toBe(1);
    expect(seenSystemPrompts[0]).not.toContain("[회상된 참고 정보");
    expect(emits.some((e) => e.kind === "finish")).toBe(true);
    expect(emits.some((e) => e.kind === "error")).toBe(false);
  });

  it("off mode with processing guard that denies embedding → turn still completes without requesting memory authorization", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(),
      schedule: vi.fn(),
      mode: () => "off",
      policy: () => ({ level: "normal", threshold: 0.86, maxItems: 3 }),
      close: async () => {},
    };
    const recallMock = vi.fn();
    const emits: AgentEmit[] = [];
    const events: string[] = [];
    const seenSystemPrompts: string[] = [];

    const provider: ProviderPort = {
      async *chat(_c, _m, o): AsyncIterable<ProviderChunk> {
        events.push("provider");
        seenSystemPrompts.push(o.systemPrompt ?? "");
        yield { kind: "text", text: "답변" };
        yield { kind: "finish" };
      },
    };

    const processingGuard: ProcessingGuardPort = {
      authorize: (input) => {
        events.push(`guard:${input.workload}`);
        return {
          kind: "processingDisclosure" as const,
          workload: input.workload,
          destination: "local_device" as const,
          decision: "allowed" as const,
          processingProfileRef: input.processingProfileRef,
          provider: input.provider.provider,
          model: input.provider.model,
        };
      },
      authorizePlan: (inputs) => {
        for (const inp of inputs) {
          events.push(`guard:${inp.workload}`);
        }
        return inputs.map((inp) => ({
          kind: "processingDisclosure" as const,
          workload: inp.workload,
          destination: "local_device" as const,
          decision: "allowed" as const,
          processingProfileRef: inp.processingProfileRef,
          provider: inp.provider.provider,
          model: inp.provider.model,
        }));
      },
      preparePlan: (inputs) => {
        for (const inp of inputs) {
          events.push(`guard:${inp.workload}`);
        }
        return {
          disclosures: inputs.map((inp) => ({
            kind: "processingDisclosure" as const,
            workload: inp.workload,
            destination: "local_device" as const,
            decision: "allowed" as const,
            processingProfileRef: inp.processingProfileRef,
            provider: inp.provider.provider,
            model: inp.provider.model,
          })),
          commit: () => true,
          rollback: () => true,
        };
      },
    };

    const deps: HandlerDeps = {
      defaultConfig: { provider: "fake", model: "m" },
      provider,
      conversation: { assemble: (req) => ({ messages: req.messages, systemPrompt: req.systemPrompt }) },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: (_id, e) => emits.push(e), emitCritical: async () => true },
      diag: { log: () => {} },
      memory: { recall: recallMock, save: vi.fn(async () => {}) },
      surfacer: fakeSurfacer,
      processingGuard,
    };
    const handler = new ChatTurnHandler(deps);

    await handler.onChatRequest({
      kind: "chat",
      requestId: "r-off-guard",
      processing: { processingProfileRef: "profile_1" },
      messages: [{ role: "user", content: "안녕" }],
    });

    const providerIndex = events.indexOf("provider");
    expect(providerIndex).toBeGreaterThanOrEqual(0);
    const firstEmbeddingGuardIndex = events.indexOf("guard:embedding");
    expect(firstEmbeddingGuardIndex === -1 || providerIndex < firstEmbeddingGuardIndex).toBe(true);
    if (firstEmbeddingGuardIndex !== -1) {
      expect(providerIndex).toBeLessThan(firstEmbeddingGuardIndex);
    }
    expect(recallMock).not.toHaveBeenCalled();
    expect(seenSystemPrompts.length).toBe(1);
    expect(seenSystemPrompts[0]).not.toContain("[회상된 참고 정보");
    expect(emits.some((e) => e.kind === "finish")).toBe(true);
    expect(emits.some((e) => e.kind === "error")).toBe(false);
  });
});
