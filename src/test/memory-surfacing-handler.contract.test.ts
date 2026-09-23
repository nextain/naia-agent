import { describe, expect, it, vi } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
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
import type { ProviderChatOpts, ProviderPort } from "../main/ports/uc1.js";

describe("ChatTurnHandler memory surfacing integration contract tests", () => {
  function makeHarness(opts: {
    surfacer?: SurfacingPort;
    recalledMemory?: RecalledMemory;
    memory?: MemoryPort;
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
      },
      diag: { log: () => {} },
      memory,
      ...(opts.surfacer ? { surfacer: opts.surfacer } : {}),
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
        judgedKeys: new Set(["기억 항목 A"]),
        surfacedCount: 1,
      })),
      schedule: vi.fn(),
      active: () => true,
      close: async () => {},
    };
    const { handler, seenSystemPrompts } = makeHarness({ surfacer: fakeSurfacer });
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
    expect(prompt).not.toContain("기억 항목 A");
    expect(prompt).toContain("기억 항목 B");
  });

  it("ready snapshot with block '' and all recalled items judged → prompt contains neither block", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => ({
        block: "",
        judgedKeys: new Set(["기억 항목 A", "기억 항목 B"]),
        surfacedCount: 0,
      })),
      schedule: vi.fn(),
      active: () => true,
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

  it("consume returns undefined → prompt equals the no-surfacer case", async () => {
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => undefined),
      schedule: vi.fn(),
      active: () => true,
      close: async () => {},
    };
    const { handler, seenSystemPrompts } = makeHarness({ surfacer: fakeSurfacer });
    const req: ChatRequest = {
      kind: "chat",
      requestId: "r4",
      messages: [{ role: "user", content: "안녕" }],
    };

    await handler.onChatRequest(req);

    const prompt = seenSystemPrompts[0];
    expect(prompt).toContain("[회상된 참고 정보 — 시작]");
    expect(prompt).toContain("기억 항목 A");
    expect(prompt).toContain("기억 항목 B");
    expect(prompt).not.toContain("[문득 떠오른 기억·지식");
  });

  it("schedule is called once with sessionId from req.sessionId (and 'default' when absent) and turns ending with assistant reply", async () => {
    const scheduleMock = vi.fn();
    const fakeSurfacer: SurfacingPort = {
      consume: vi.fn(() => undefined),
      schedule: scheduleMock,
      active: () => true,
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
      active: () => true,
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
      active: () => true,
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
      active: () => true,
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
});
