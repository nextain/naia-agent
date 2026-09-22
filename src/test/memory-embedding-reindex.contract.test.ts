import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAdapter, type EmbeddingProvider } from "@nextain/naia-memory";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { ChatRequest, AgentEmit, ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";
import { isEmbeddingSpaceMismatchError, MEMORY_INDEX_UNAVAILABLE_NOTICE } from "../main/domain/memory.js";

class FixedEmbedder implements EmbeddingProvider {
  readonly name = "fixed";
  readonly dims = 2;
  constructor(readonly embeddingSpaceId: string, private readonly fail = false) {}
  async embed(text: string): Promise<number[]> {
    if (this.fail) throw new Error("test embedding unavailable");
    return text.includes("코드명") ? [1, 0] : [0, 1];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

function capturingProvider() {
  const seen: Array<string | undefined> = [];
  const provider: ProviderPort = {
    async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], o: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      seen.push(o.systemPrompt);
      yield { kind: "text", text: "응답" };
      yield { kind: "finish" };
    },
  };
  return { provider, seen };
}

function harness(o: { provider: ProviderPort; memory?: MemoryPort }) {
  const emits: AgentEmit[] = [];
  const deps: HandlerDeps = {
    provider: o.provider,
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: () => {} },
    ...(o.memory ? { memory: o.memory } : {}),
  };
  return { deps, emits };
}

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "ollama", model: "gemma4" }, messages: [{ role: "user", content: "내 코드명이 뭐였지?" }], ...o,
});

describe("FR-MEM-17 embedding-space reindex product path", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { space: "model-b", fail: false, phases: ["start", "done"] },
    { space: "model-b", fail: true, phases: ["start", "failed"] },
    { space: "model-a", fail: false, phases: [] },
  ])("observes reindex once at ready: $space, fail=$fail", async ({ space, fail, phases }) => {
    const dir = mkdtempSync(join(tmpdir(), "naia-agent-reindex-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, "store.json");
    const now = Date.now();
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      episodes: [],
      facts: [{
        id: "fact-1",
        content: "비밀 코드명은 오메가",
        entities: [],
        topics: [],
        createdAt: now,
        updatedAt: now,
        importance: 1,
        recallCount: 0,
        lastAccessed: now,
        strength: 1,
        status: "active",
        sourceEpisodes: [],
        encodingContext: { project: "p" },
      }],
      skills: [],
      reflections: [],
      associations: {},
      factEmbeddings: { "fact-1": [1, 0] },
      episodeEmbeddings: {},
      embeddingSpaceId: "model-a",
    }));
    const events: Array<{ phase: string; reason: string; error?: string }> = [];
    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      embeddingProvider: new FixedEmbedder(space, fail),
      onEmbeddingReindex: (event) => { events.push(event); },
    });
    expect(events.map((e) => e.phase)).toEqual(phases.slice(0, 1));
    await Promise.all([memory.ready(), memory.ready()]);
    await memory.ready();
    expect(events.map((e) => e.phase)).toEqual(phases);
    if (fail) {
      const failedEvent = events.find((e) => e.phase === "failed");
      const hasGetter = typeof (LocalAdapter.prototype as any).getEmbeddingReindexError === "function";
      if (hasGetter) {
        expect(failedEvent?.error).toContain("test embedding unavailable");
      } else {
        expect(failedEvent?.error).toBeUndefined();
      }
      await expect(memory.recall("코드명")).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
    } else {
      const recalled = await memory.recall("코드명");
      expect(recalled.facts.join(" ")).toContain("오메가");
    }
    const persisted = JSON.parse(readFileSync(storePath, "utf8"));
    expect(persisted.embeddingSpaceId).toBe(fail ? "model-a" : space);
    expect(persisted.facts[0].content).toBe("비밀 코드명은 오메가");
    await memory.close();
  });

  it("injects a trusted index notice instead of empty memory on mismatch recall", async () => {
    const { provider, seen } = capturingProvider();
    const err = Object.assign(
      new Error("LocalAdapter: legacy vectors have no embedding-space identity (current=offline:e5); call reindexEmbeddings()"),
      { name: "EmbeddingSpaceMismatchError", code: "EMBEDDING_SPACE_MISMATCH" },
    );
    const memory: MemoryPort = {
      recall: async () => { throw err; },
      save: async () => {},
    };
    const { deps, emits } = harness({ provider, memory });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    expect(isEmbeddingSpaceMismatchError(err)).toBe(true);
    expect(seen[0]).toContain(MEMORY_INDEX_UNAVAILABLE_NOTICE);
    expect(seen[0]).toContain("비어 있지 않습니다");
  });

  it("wires product reindex at LocalAdapter open and compose stderr", () => {
    const compose = readFileSync(new URL("../../scripts/builds/compose-agent-deps.mjs", import.meta.url), "utf8");
    const adapter = readFileSync(new URL("../main/adapters/naia-memory.ts", import.meta.url), "utf8");
    expect(adapter).toContain("reindexEmbeddingsOnMismatch: true");
    expect(adapter).toContain("getEmbeddingSpaceMismatch");
    expect(compose).toContain("onEmbeddingReindex");
    expect(compose).toContain("store is not empty");
    expect(compose).toContain("cause:");
  });

  it("still omits injection for generic recall failures", async () => {
    const { provider, seen } = capturingProvider();
    const memory: MemoryPort = { recall: async () => { throw new Error("recall down"); }, save: async () => {} };
    const { deps } = harness({ provider, memory });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen[0]).toBeUndefined();
  });
});
