import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@nextain/naia-memory";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import type { MemoryPort } from "../main/ports/memory.js";
import type { ChatRequest, AgentEmit, ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";
import { isMemoryPreparingError, MEMORY_INDEX_UNAVAILABLE_NOTICE } from "../main/domain/memory.js";

class GatedEmbedder implements EmbeddingProvider {
  readonly name = "gated";
  readonly dims = 2;
  private releaseGate!: () => void;
  private readonly gatePromise: Promise<void>;

  constructor(readonly embeddingSpaceId: string) {
    this.gatePromise = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate();
  }

  async embed(text: string): Promise<number[]> {
    await this.gatePromise;
    return text.includes("코드명") ? [1, 0] : [0, 1];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.gatePromise;
    return Promise.all(texts.map((text) => (text.includes("코드명") ? [1, 0] : [0, 1])));
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
  kind: "chat",
  requestId: "r-prep-1",
  provider: { provider: "fake", model: "m" },
  messages: [{ role: "user", content: "내 코드명이 뭐였지?" }],
  ...o,
});

describe("FR-MEM-20 memory background preparation contract", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("fails recall fast with MEMORY_PREPARING while preparation is pending, then recalls normally after ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-agent-prep-"));
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

    const embedder = new GatedEmbedder("model-b");
    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      embeddingProvider: embedder,
    });

    const start = Date.now();
    const recallPromise = memory.recall("x");
    await expect(recallPromise).rejects.toMatchObject({
      name: "MemoryPreparingError",
      code: "MEMORY_PREPARING",
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(3000);

    embedder.release();
    await memory.ready();

    const recalled = await memory.recall("코드명");
    expect(recalled.facts.join(" ")).toContain("오메가");
    await memory.close();
  });

  it("resolves recall without error immediately after makeNaiaMemory for keyword-only memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-agent-prep-kw-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const storePath = join(dir, "store.json");

    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
    });

    const recalled = await memory.recall("test");
    expect(recalled).toEqual({ facts: [], factScores: [], episodes: [], reflections: [] });
    await memory.close();
  });

  it("injects unavailable notice and completes quickly when recall fails with MEMORY_PREPARING", async () => {
    const { provider, seen } = capturingProvider();
    const prepErr = Object.assign(new Error("memory is preparing (model load / reindex in progress)"), {
      name: "MemoryPreparingError",
      code: "MEMORY_PREPARING",
    });
    const memory: MemoryPort = {
      recall: async () => {
        throw prepErr;
      },
      save: async () => {},
    };
    const { deps, emits } = harness({ provider, memory });
    const start = Date.now();
    await new ChatTurnHandler(deps).onChatRequest(req());
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1000);
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    expect(isMemoryPreparingError(prepErr)).toBe(true);
    expect(seen[0]).toContain(MEMORY_INDEX_UNAVAILABLE_NOTICE);
    expect(seen[0]).toContain("비어 있지 않습니다");
  });

  it("asserts compose-agent-deps builds memory in background without awaiting ready() before return", () => {
    const compose = readFileSync(new URL("../../scripts/builds/compose-agent-deps.mjs", import.meta.url), "utf8");
    const buildMemoryIndex = compose.indexOf("const buildMemory");
    expect(buildMemoryIndex).toBeGreaterThan(0);
    const labelIndex = compose.indexOf("const label =", buildMemoryIndex);
    expect(labelIndex).toBeGreaterThan(buildMemoryIndex);

    const betweenBuildAndLabel = compose.slice(buildMemoryIndex, labelIndex);
    expect(betweenBuildAndLabel).not.toContain("await next.ready()");
    expect(compose).toContain("memory preparing in background");
    expect(compose).toContain("memory preparation failed");
  });

  it("verifies isMemoryPreparingError predicate contract", () => {
    expect(isMemoryPreparingError({ name: "MemoryPreparingError" })).toBe(true);
    expect(isMemoryPreparingError({ code: "MEMORY_PREPARING" })).toBe(true);
    expect(isMemoryPreparingError(new Error("unrelated"))).toBe(false);
    expect(isMemoryPreparingError(null)).toBe(false);
    expect(isMemoryPreparingError("MEMORY_PREPARING")).toBe(false);
  });
});
