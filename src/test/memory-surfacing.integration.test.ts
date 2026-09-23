import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspaceKnowledge } from "@naia/kb-compiler";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";
import {
  makeCompileKnowledge,
  makeKbCompilerBackend,
  readWorkspaceKnowledgeConfig,
} from "../main/adapters/knowledge-compile.js";
import { makeMemorySurfacer, type SurfacingLlm } from "../main/app/memory-surfacer.js";
import { ChatTurnHandler } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import type { ChatMessage, ProviderChunk, ProviderConfig } from "../main/domain/chat.js";
import type { ProviderChatOpts, ProviderPort } from "../main/ports/uc1.js";

async function pollUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("memory-surfacing integration tests with real naia-memory & kb-compiler", () => {
  const dirs: string[] = [];
  let memoryInstance: { close(): Promise<void> } | null = null;
  let surfacerInstance: { close(): Promise<void> } | null = null;

  afterEach(async () => {
    if (surfacerInstance) {
      await surfacerInstance.close();
      surfacerInstance = null;
    }
    if (memoryInstance) {
      await memoryInstance.close();
      memoryInstance = null;
    }
    while (dirs.length) {
      await rm(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("hermetic surfacing IT: real keyword memory, real compiled knowledge, fake LLM scenarios", async () => {
    const adk = await mkdtemp(join(tmpdir(), "surf-it-"));
    dirs.push(adk);

    // 1. Setup real naia-memory (keyword-only)
    const storePath = join(adk, "store.json");
    const memory = makeNaiaMemory({
      project: "it-692",
      storePath,
      sessionId: "it",
    });
    memoryInstance = memory;

    await memory.save("나는 밀면을 제일 좋아해", "기억할게요");
    await memory.save("내 강아지 이름은 보리야", "보리 귀엽네요");

    // 2. Compile real knowledge
    const srcDir = join(adk, "sources", "corp");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, "nextain.md"),
      "# 넥스테인\n\n넥스테인의 주력 제품은 **Naia**입니다. AI 허브 런타임을 개발합니다.\n",
      "utf8",
    );
    await mkdir(join(adk, "naia-settings"), { recursive: true });
    await writeFile(
      join(adk, "naia-settings", "knowledge.json"),
      JSON.stringify({ version: 1, scope: "corp", sources: [{ path: srcDir }] }),
      "utf8",
    );

    const compile = makeCompileKnowledge({
      readConfig: readWorkspaceKnowledgeConfig,
      backend: makeKbCompilerBackend(),
    });
    const compResult = await compile(adk);
    expect(compResult.ok).toBe(true);

    const { service } = await openWorkspaceKnowledge(
      join(adk, "naia-settings", "knowledge", "corp"),
    );
    const knowledgeSource = {
      search: async (query: string, k?: number) => {
        const hits = await service.search(query, k);
        return hits.map((h: any) => ({
          title: h.title ?? "",
          snippet: h.snippet ?? "",
          score: typeof h.score === "number" ? h.score : 1,
          sourceUris: Array.isArray(h.sourceUris) ? h.sourceUris : [],
        }));
      },
    };

    // 3. Fake LLM based on keyword matching
    let targetWords: string[] = [];
    let llmCallCount = 0;
    const fakeLlm: SurfacingLlm = {
      provider: "it-fake",
      model: "nano",
      async completeMessages(messages) {
        llmCallCount++;
        const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
        const items: Array<{ id: string; reason: string; confidence: number }> = [];
        const lines = userMsg.split("\n");
        for (const line of lines) {
          const match = /^<([mk]\d+)>/.exec(line);
          if (match) {
            const id = match[1];
            if (targetWords.some((w) => line.includes(w))) {
              items.push({ id, reason: "키워드 일치", confidence: 0.9 });
            }
          }
        }
        return JSON.stringify({ items });
      },
    };

    const surfacer = makeMemorySurfacer({
      memory,
      knowledge: knowledgeSource,
      llm: () => fakeLlm,
      diag: { log: () => {}, debug: () => {} },
    });
    surfacerInstance = surfacer;

    // Scenario 1: "부산 가면 밀면 먹을까?" → surfaced block contains "밀면"
    targetWords = ["밀면"];
    surfacer.schedule({
      sessionId: "s1",
      turns: [{ role: "user", content: "부산 가면 밀면 먹을까?" }],
    });
    await pollUntil(() => llmCallCount >= 1);
    await new Promise((r) => setTimeout(r, 40));
    const snap1 = surfacer.consume("s1");
    expect(snap1).toBeDefined();
    expect(snap1!.block).toContain("밀면");
    expect(snap1!.surfacedCount).toBe(1);

    // Scenario 2: "안녕, 반가워" with LLM selecting nothing → block ""
    targetWords = [];
    surfacer.schedule({
      sessionId: "s2",
      turns: [{ role: "user", content: "안녕, 반가워" }],
    });
    await pollUntil(() => llmCallCount >= 2);
    await new Promise((r) => setTimeout(r, 40));
    const snap2 = surfacer.consume("s2");
    expect(snap2).toBeDefined();
    expect(snap2!.block).toBe("");
    expect(snap2!.surfacedCount).toBe(0);

    // Scenario 3: "넥스테인 제품이 뭐였지?" → block contains a "(지식 · " line
    targetWords = ["넥스테인"];
    surfacer.schedule({
      sessionId: "s3",
      turns: [{ role: "user", content: "넥스테인 제품이 뭐였지?" }],
    });
    await pollUntil(() => llmCallCount >= 3);
    await new Promise((r) => setTimeout(r, 40));
    const snap3 = surfacer.consume("s3");
    expect(snap3).toBeDefined();
    expect(snap3!.block).toContain("(지식 · ");
    expect(snap3!.block).toContain("Naia");

    // Wire into real ChatTurnHandler for Scenario 1 two-turn flow
    targetWords = ["밀면"];
    const seenPrompts: string[] = [];
    const provider: ProviderPort = {
      async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
        seenPrompts.push(opts.systemPrompt ?? "");
        yield { kind: "text", text: "밀면 맛있죠!" };
        yield { kind: "finish" };
      },
    };

    const handler = new ChatTurnHandler({
      defaultConfig: { provider: "fake", model: "m" },
      provider,
      conversation: { assemble: (r) => ({ messages: r.messages, systemPrompt: r.systemPrompt }) },
      credentials: makeInMemoryCredentials(),
      approval: makeInMemoryApproval(),
      egress: { emit: () => {} },
      diag: { log: () => {} },
      memory,
      surfacer,
    });

    const callsBeforeTurn1 = llmCallCount;
    // Turn 1: user asks about 부산/밀면
    await handler.onChatRequest({
      kind: "chat",
      requestId: "flow-t1",
      sessionId: "flow-session",
      messages: [{ role: "user", content: "부산 가면 밀면 먹을까?" }],
    });

    // Wait for the background surfacing job scheduled after turn 1 to complete
    await pollUntil(() => llmCallCount > callsBeforeTurn1);
    await new Promise((r) => setTimeout(r, 50));

    // Turn 2: next question in the same session
    await handler.onChatRequest({
      kind: "chat",
      requestId: "flow-t2",
      sessionId: "flow-session",
      messages: [
        { role: "user", content: "부산 가면 밀면 먹을까?" },
        { role: "assistant", content: "밀면 맛있죠!" },
        { role: "user", content: "어디가 맛있어?" },
      ],
    });

    // Turn 2 system prompt should contain surfaced memory
    expect(seenPrompts.length).toBe(2);
    expect(seenPrompts[1]).toContain("[문득 떠오른 기억·지식 — 시작]");
    expect(seenPrompts[1]).toContain("밀면");
  });
});
