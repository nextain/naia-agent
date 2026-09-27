import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import type { ChatMessage, ProviderChunk, ProviderConfig } from "../main/domain/chat.js";
import { normalizeAvatarThinkingTag, flushAvatarThinkingTag } from "../main/domain/chat.js";
import { stripAssistantMemoryTags } from "../main/domain/memory.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { ProviderChatOpts, ProviderPort, ToolExecutorPort } from "../main/ports/uc1.js";

function makeHarness(provider: ProviderPort, memory?: MemoryPort, toolExecutor?: ToolExecutorPort) {
  const emits: Array<{ kind: string; text?: string }> = [];
  const deps: HandlerDeps = {
    provider,
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: { update: () => {}, get: () => undefined },
    approval: makeInMemoryApproval(),
    egress: { emit: (_rid, event) => emits.push(event as { kind: string; text?: string }) },
    diag: { log: () => {}, debug: () => {} },
    ...(memory ? { memory } : {}),
    ...(toolExecutor ? { toolExecutor } : {}),
  };
  return { deps, emits };
}

describe("stripAssistantMemoryTags (FR-MEM-27 domain)", () => {
  it("strips emotion tags case-insensitively and preserves [1] and markdown links", () => {
    const input = "[NEUTRAL] Here is the result [1] and [link](https://example.com).";
    expect(stripAssistantMemoryTags(input)).toBe("Here is the result [1] and [link](https://example.com).");

    expect(stripAssistantMemoryTags("[HAPPY] Great job!")).toBe("Great job!");
    expect(stripAssistantMemoryTags("[sad] Oh no.")).toBe("Oh no.");
    expect(stripAssistantMemoryTags("[Angry] Grr.")).toBe("Grr.");
    expect(stripAssistantMemoryTags("[SURPRISED] Wow!")).toBe("Wow!");
    expect(stripAssistantMemoryTags("[think] Let me see.")).toBe("Let me see.");
    expect(stripAssistantMemoryTags("[THINKING] Considering.")).toBe("Considering.");
  });

  it("strips closed <think>...</think> blocks, and unclosed <think> keeps subsequent answer (fail-safe)", () => {
    const input = "<think>\ninternal reasoning\nstep 2\n</think>[NEUTRAL] The answer is 42.";
    expect(stripAssistantMemoryTags(input)).toBe("The answer is 42.");

    // Unclosed <think> drops only opener so following answer is not wiped out
    const unclosedWithAnswer = "<think>reason\nThe answer is 42.";
    const stripped = stripAssistantMemoryTags(unclosedWithAnswer);
    expect(stripped).toBe("reason\nThe answer is 42.");
    expect(stripped).toContain("The answer is 42.");

    // Unclosed tag alone with no following content trims to empty
    expect(stripAssistantMemoryTags("<think>")).toBe("");
  });

  it("strips bracketed think blocks including mixed-case closers [THINK]...[/think] and [thinking]...[/THINKING]", () => {
    const input = "[THINK] intermediate reasoning [/THINK] The final answer.";
    expect(stripAssistantMemoryTags(input)).toBe("The final answer.");

    const input2 = "[thinking] reasoning [/thinking] Final text.";
    expect(stripAssistantMemoryTags(input2)).toBe("Final text.");

    // Mixed-case tests per review item 2
    expect(stripAssistantMemoryTags("[THINK] internal [/think] Final")).toBe("Final");
    expect(stripAssistantMemoryTags("[thinking]x[/THINKING] y")).toBe("y");
  });

  it("consumes one trailing horizontal space after bracketed think blocks without eating newlines", () => {
    expect(stripAssistantMemoryTags("Hello [thinking]x[/thinking] there")).toBe("Hello there");
    expect(stripAssistantMemoryTags("Hello [think]x[/think] there")).toBe("Hello there");
    // Newline is not eaten; space before tag is preserved
    expect(stripAssistantMemoryTags("Hello [thinking]x[/thinking]\nthere")).toBe("Hello \nthere");
  });

  it("handles fenced code blocks containing think tags (hide-rather-than-leak tradeoff per #114)", () => {
    expect(stripAssistantMemoryTags("```<think>x</think>```")).toBe("``````");
    expect(stripAssistantMemoryTags("```[think]x[/think]```")).toBe("``````");
    expect(stripAssistantMemoryTags("```[thinking]x[/thinking]```")).toBe("``````");
  });

  it("returns empty string when answer is only a tag or thinking", () => {
    expect(stripAssistantMemoryTags("[NEUTRAL]")).toBe("");
    expect(stripAssistantMemoryTags("[HAPPY] [THINKING]")).toBe("");
    expect(stripAssistantMemoryTags("<think>only thoughts</think>")).toBe("");
    expect(stripAssistantMemoryTags("   [NEUTRAL]   ")).toBe("");
    expect(stripAssistantMemoryTags(undefined)).toBe("");
  });

  it("does not strip user text or normal bracketed text", () => {
    expect(stripAssistantMemoryTags("Ref [123] and [important notice]")).toBe("Ref [123] and [important notice]");
  });
});

describe("FR-MEM-27 ChatTurnHandler × MemoryPort contract", () => {
  it("turn whose stream has thinking chunks and a reply starting with [NEUTRAL] saves only clean answer", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "thinking", text: "Internal model reasoning: checking data..." };
        yield { kind: "text", text: "[NEUTRAL] Here is the clean answer [1] and [doc link](https://example.com/api)." };
        yield { kind: "finish" };
      },
    };

    const { deps } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-clean-1",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Tell me about [1]" }],
    });

    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    const [savedUser, savedAssistant] = calls[0];
    expect(savedUser).toBe("Tell me about [1]");
    expect(savedAssistant).toBe("Here is the clean answer [1] and [doc link](https://example.com/api).");
    expect(savedAssistant).not.toContain("Internal model reasoning");
    expect(savedAssistant).not.toContain("[NEUTRAL]");
    expect(savedAssistant).toContain("[1]");
    expect(savedAssistant).toContain("[doc link](https://example.com/api)");
  });

  it("an answer that is only a tag saves no assistant episode in naia-memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "naia-mem-strip-"));
    const storePath = join(dir, "store.json");
    try {
      const memory = makeNaiaMemory({ storePath, project: "tag-only-test", sessionId: "s1" });
      const provider: ProviderPort = {
        async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
          yield { kind: "text", text: "[NEUTRAL]" };
          yield { kind: "finish" };
        },
      };

      const { deps } = makeHarness(provider, memory);
      const handler = new ChatTurnHandler(deps);
      await handler.onChatRequest({
        kind: "chat",
        requestId: "req-tag-only",
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content: "Hello there" }],
      });

      await memory.close();

      const store = JSON.parse(await readFile(storePath, "utf8")) as {
        episodes: Array<{ role?: string; content: string }>;
      };
      // User episode must be saved
      expect(store.episodes.some((e) => e.role === "user" && e.content.includes("Hello there"))).toBe(true);
      // Assistant episode must NOT be saved because the answer was only a tag
      expect(store.episodes.some((e) => e.role === "assistant")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reasoning-only answer folds into final answer and is persisted to memory (#639)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "naia-mem-thinking-only-"));
    const storePath = join(dir, "store.json");
    try {
      const memory = makeNaiaMemory({ storePath, project: "thinking-only-test", sessionId: "s1" });
      const provider: ProviderPort = {
        async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
          yield { kind: "thinking", text: "Just thinking to myself..." };
          yield { kind: "finish" };
        },
      };

      const { deps, emits } = makeHarness(provider, memory);
      const handler = new ChatTurnHandler(deps);
      await handler.onChatRequest({
        kind: "chat",
        requestId: "req-thinking-only",
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content: "What do you think?" }],
      });

      // UI receives folded text per #639
      expect(emits.some((e) => e.kind === "text" && (e.text ?? "").includes("Just thinking"))).toBe(true);

      await memory.close();

      const store = JSON.parse(await readFile(storePath, "utf8")) as {
        episodes: Array<{ role?: string; content: string }>;
      };
      // User episode must be saved
      expect(store.episodes.some((e) => e.role === "user" && e.content.includes("What do you think?"))).toBe(true);
      // Assistant episode must be saved with the folded answer (#639: it is what user saw)
      expect(store.episodes.some((e) => e.role === "assistant" && e.content.includes("Just thinking"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("direct naia-memory.save strips tags and skips assistant episode if empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "naia-mem-direct-"));
    const storePath = join(dir, "store.json");
    try {
      const memory = makeNaiaMemory({ storePath, project: "direct-test", sessionId: "s1" });
      await memory.save("User question with [NEUTRAL] intact", "[NEUTRAL] [THINKING]");
      await memory.close();

      const store = JSON.parse(await readFile(storePath, "utf8")) as {
        episodes: Array<{ role?: string; content: string }>;
      };
      // User text must not be stripped
      expect(store.episodes.some((e) => e.role === "user" && e.content.includes("[NEUTRAL]"))).toBe(true);
      // Assistant episode must not exist since it only had tags
      expect(store.episodes.some((e) => e.role === "assistant")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unfulfilled action promise retry does not double-commit preliminary text to memory", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    let callCount = 0;
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        callCount++;
        if (callCount === 1) {
          // Unfulfilled promise without tool calls
          yield { kind: "text", text: "I will check the weather for you now." };
          yield { kind: "finish" };
        } else {
          // Retry round
          yield { kind: "text", text: "[NEUTRAL] The weather is sunny and 22°C." };
          yield { kind: "finish" };
        }
      },
    };

    const toolExecutor: ToolExecutorPort = {
      specs: () => [{ name: "get_weather", description: "Get weather", parameters: {} }],
      execute: async () => ({ output: "" }),
    };

    const { deps } = makeHarness(provider, memory, toolExecutor);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-promise-retry",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "What is the weather?" }],
    });

    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    const [_savedUser, savedAssistant] = calls[0];
    // Memory should contain only the final retry answer, not the unfulfilled action promise
    expect(savedAssistant).toBe("The weather is sunny and 22°C.");
    expect(savedAssistant).not.toContain("I will check");
  });

  it("normalises split [THI + NKING] in handler text stream to [THINK] for avatar", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "[THI" };
        yield { kind: "text", text: "NKING] Hello user!" };
        yield { kind: "finish" };
      },
    };

    const { deps, emits } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-split-tag",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Hi" }],
    });

    // Emitted text chunks to avatar have [THINK] rather than raw [THINKING]
    const textEmits = emits.filter((e) => e.kind === "text").map((e) => e.text).join("");
    expect(textEmits).toBe("[THINK] Hello user!");

    // Memory strips the emotion tag
    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    expect(calls[0][1]).toBe("Hello user!");
  });

  it("does not flush held partial [thinking prefix when a thinking chunk arrives between text split", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "[THI" };
        yield { kind: "thinking", text: "thought in between" };
        yield { kind: "text", text: "NKING] Hello user!" };
        yield { kind: "finish" };
      },
    };

    const { deps, emits } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-split-with-thinking",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Hi" }],
    });

    const textEmits = emits.filter((e) => e.kind === "text").map((e) => e.text).join("");
    expect(textEmits).toBe("[THINK] Hello user!");
    expect(textEmits).not.toContain("[THINKING]");

    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    expect(calls[0][1]).toBe("Hello user!");
  });

  it("handler drops closed [THINKING]...[/THINKING] from display and saves clean answer in memory", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "[THINKING] secret [/THINKING] The answer" };
        yield { kind: "finish" };
      },
    };

    const { deps, emits } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-closed-thinking",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Tell me the answer" }],
    });

    // Emitted display text drops the closed thinking block
    const textEmits = emits.filter((e) => e.kind === "text").map((e) => e.text).join("");
    expect(textEmits).toBe("The answer");
    expect(textEmits).not.toContain("secret");

    // Memory saves only the clean answer
    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    expect(calls[0][1]).toBe("The answer");
    expect(calls[0][1]).not.toContain("secret");
  });

  it("handler across chunk split: provider yields '[THINKING] secret ' then '[/THINKING] The answer' saves clean answer in memory while asserting display stream as it currently streams", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "[THINKING] secret " };
        yield { kind: "text", text: "[/THINKING] The answer" };
        yield { kind: "finish" };
      },
    };

    const { deps, emits } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-split-thinking-chunks",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Tell me the answer" }],
    });

    // Display stream as it currently streams (no end-of-stream buffering; unclosed [THINKING] answer must keep streaming)
    const textEmits = emits.filter((e) => e.kind === "text").map((e) => e.text).join("");
    expect(textEmits).toBe("[THINK] secret [/THINKING] The answer");

    // Memory saves only the clean answer
    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    expect(calls[0][1]).toBe("The answer");
    expect(calls[0][1]).not.toContain("secret");
  });

  it("handler normalises unclosed [THINKING] to [THINK] for avatar while keeping subsequent answer", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "[THINKING] The answer" };
        yield { kind: "finish" };
      },
    };

    const { deps, emits } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-unclosed-thinking",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Tell me the answer" }],
    });

    const textEmits = emits.filter((e) => e.kind === "text").map((e) => e.text).join("");
    expect(textEmits).toBe("[THINK] The answer");

    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    expect(calls[0][1]).toBe("The answer");
  });

  it("normalises #639 folded reasoning before emit to display", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "thinking", text: "[THINKING] Only reasoning was provided" };
        yield { kind: "finish" };
      },
    };

    const { deps, emits } = makeHarness(provider, memory);
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-fold-norm",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Hi" }],
    });

    const textEmits = emits.filter((e) => e.kind === "text").map((e) => e.text).join("");
    expect(textEmits).toBe("[THINK] Only reasoning was provided");
    expect(textEmits).not.toContain("[THINKING]");

    expect(save).toHaveBeenCalledOnce();
    const calls = save.mock.calls as unknown as Array<[string, string]>;
    expect(calls[0][1]).toBe("Only reasoning was provided");
  });

  it("turn commit latch: authorize deny in commitCompletedTurn emits terminal error and blocks finish", async () => {
    const save = vi.fn(async () => {});
    const memory: MemoryPort = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _messages: readonly ChatMessage[], _opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "Answer" };
        yield { kind: "finish" };
      },
    };
    const guard = {
      preparePlan: (inputs: Array<{ workload: string }>) => ({
        disclosures: inputs.map((input) => ({
          decision: (input.workload === "memory_llm" || input.workload === "embedding") ? ("blocked" as const) : ("allowed" as const),
          reason: "memory denied by policy",
          code: "PROCESSING_DESTINATION_DENIED" as const,
        })),
        commit: () => true,
        rollback: () => true,
      }),
    };

    const emits: Array<{ kind: string; message?: string; code?: string }> = [];
    const emitCritical = vi.fn(async () => true);
    const deps: HandlerDeps = {
      provider,
      conversation: { assemble: (r) => ({ messages: r.messages }) },
      credentials: { update: () => {}, get: () => undefined },
      approval: makeInMemoryApproval(),
      egress: {
        emit: (_rid, event) => {
          emits.push(event as { kind: string; message?: string; code?: string });
        },
        emitCritical,
      },
      diag: { log: () => {}, debug: () => {} },
      memory,
      processingGuard: guard as never,
    };
    const handler = new ChatTurnHandler(deps);
    await handler.onChatRequest({
      kind: "chat",
      requestId: "req-auth-deny",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "Hi" }],
      processing: { processingProfileRef: "profile-1" },
    });

    // Main LLM allowed and executed, emitCritical delivered disclosure
    expect(emitCritical).toHaveBeenCalled();
    // Denied memory save is not executed
    expect(save).not.toHaveBeenCalled();
    // Reached commitCompletedTurn, where authorizeOperations denied memory and emitted terminal error
    expect(emits).toContainEqual(
      expect.objectContaining({
        kind: "error",
        code: "EXTERNAL_PROCESSING_FORBIDDEN",
      }),
    );
    // Terminal finish was never emitted (turnCommitted was not latched)
    expect(emits.filter((e) => e.kind === "finish")).toHaveLength(0);
  });
});

describe("normalizeAvatarThinkingTag (FR-MEM-27 / #639 display leak)", () => {
  it("normalises standalone [THINKING] to [THINK] case-insensitively", () => {
    expect(normalizeAvatarThinkingTag("[THINKING] Hello").emitted).toBe("[THINK] Hello");
    expect(normalizeAvatarThinkingTag("[thinking] Hello").emitted).toBe("[THINK] Hello");
    expect(normalizeAvatarThinkingTag("[Thinking] Hello").emitted).toBe("[THINK] Hello");
  });

  it("drops closed [thinking]...[/thinking] blocks from display text only when both opener and closer are present", () => {
    expect(normalizeAvatarThinkingTag("[THINKING] secret [/THINKING] The answer").emitted).toBe("The answer");
    expect(normalizeAvatarThinkingTag("[thinking] internal [/thinking] The answer").emitted).toBe("The answer");
    expect(normalizeAvatarThinkingTag("[thinking] secret [/thinking]").emitted).toBe("");
  });

  it("leaves unclosed [THINKING] as [THINK] so subsequent answer is not swallowed", () => {
    expect(normalizeAvatarThinkingTag("[THINKING] The answer").emitted).toBe("[THINK] The answer");
    expect(normalizeAvatarThinkingTag("[thinking] The answer").emitted).toBe("[THINK] The answer");
  });

  it("does not alter non-matching bracket tags", () => {
    expect(normalizeAvatarThinkingTag("[1] reference").emitted).toBe("[1] reference");
    expect(normalizeAvatarThinkingTag("[thinking process] note").emitted).toBe("[thinking process] note");
    expect(normalizeAvatarThinkingTag("[table").emitted).toBe("[table");
  });

  it("buffers partial tag across chunk boundaries and normalises when completed", () => {
    // 2-chunk split
    const c1 = normalizeAvatarThinkingTag("[THI", "");
    expect(c1.emitted).toBe("");
    expect(c1.remainder).toBe("[THI");

    const c2 = normalizeAvatarThinkingTag("NKING] Hi", c1.remainder);
    expect(c2.emitted).toBe("[THINK] Hi");
    expect(c2.remainder).toBe("");

    // 3-chunk split
    const s1 = normalizeAvatarThinkingTag("[TH", "");
    expect(s1.remainder).toBe("[TH");
    const s2 = normalizeAvatarThinkingTag("IN", s1.remainder);
    expect(s2.remainder).toBe("[THIN");
    const s3 = normalizeAvatarThinkingTag("KING] Hi", s2.remainder);
    expect(s3.emitted).toBe("[THINK] Hi");
    expect(s3.remainder).toBe("");
  });

  it("buffers partial closing tag and drops completed closed block across chunk boundaries", () => {
    const c1 = normalizeAvatarThinkingTag("[THINKING] secret [/THI", "");
    expect(c1.emitted).toBe("");
    expect(c1.remainder).toBe("[THINKING] secret [/THI");

    const c2 = normalizeAvatarThinkingTag("NKING] The answer", c1.remainder);
    expect(c2.emitted).toBe("The answer");
    expect(c2.remainder).toBe("");
  });

  it("emits non-matching partial tag on flush at stream end", () => {
    const c1 = normalizeAvatarThinkingTag("Leading text [THI", "");
    expect(c1.emitted).toBe("Leading text ");
    expect(c1.remainder).toBe("[THI");
    expect(flushAvatarThinkingTag(c1.remainder)).toBe("[THI");
  });
});
