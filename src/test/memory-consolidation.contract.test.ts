import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Episode } from "@nextain/naia-memory";
import { makeNaiaMemory, type MemoryConsolidationEvent } from "../main/adapters/naia-memory.js";

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function makeStoreFixture(now = Date.now()) {
  return {
    version: 1,
    episodes: [
      {
        id: "ep-1",
        content: "나는 서울에 살아",
        summary: "",
        role: "user" as const,
        timestamp: now - 60 * 60_000,
        importance: { importance: 0.8, surprise: 0, emotion: 0, utility: 0.8 },
        encodingContext: { project: "p" },
        consolidated: false,
        recallCount: 0,
        lastAccessed: now - 60 * 60_000,
        strength: 1,
      },
    ],
    facts: [],
    skills: [],
    reflections: [],
    associations: {},
  };
}

describe("FR-MEM-21 memory consolidation contract (nextain/naia-agent#141)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to off: without consolidation option extractor is never called and recall has no facts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-consolidation-off-"));
    dirs.push(dir);
    const storePath = join(dir, "store.json");
    writeFileSync(storePath, JSON.stringify(makeStoreFixture()));

    const factExtractor = vi.fn(async () => [
      {
        content: "사용자 거주지: 서울",
        entities: [],
        topics: ["p"],
        importance: 0.8,
        maxEmotion: 0,
        sourceEpisodeIds: ["ep-1"],
      },
    ]);

    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      factExtractor,
    });
    await memory.ready();

    await new Promise((r) => setTimeout(r, 150));
    expect(factExtractor).not.toHaveBeenCalled();

    const recalled = await memory.recall("거주지");
    expect(recalled.facts).toEqual([]);

    await memory.close();
  });

  it("runs background consolidation with configured delays, persists facts, and marks episodes consolidated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-consolidation-sched-"));
    dirs.push(dir);
    const storePath = join(dir, "store.json");
    writeFileSync(storePath, JSON.stringify(makeStoreFixture()));

    const factExtractor = vi.fn(async () => [
      {
        content: "사용자 거주지: 서울",
        entities: [],
        topics: ["p"],
        importance: 0.8,
        maxEmotion: 0,
        sourceEpisodeIds: ["ep-1"],
      },
    ]);

    const events: MemoryConsolidationEvent[] = [];
    const onConsolidation = vi.fn((event: MemoryConsolidationEvent) => {
      events.push(event);
    });

    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      factExtractor,
      consolidation: { initialDelayMs: 10, intervalMs: 1_000 },
      onConsolidation,
    });
    await memory.ready();

    await waitFor(() => events.some((e) => e.phase === "done"), 5000);
    const doneEvent = events.find((e) => e.phase === "done");
    expect(doneEvent).toMatchObject({
      phase: "done",
      episodesProcessed: 1,
      factsCreated: 1,
    });

    const recalled = await memory.recall("거주지");
    expect(recalled.facts.join(" ")).toContain("서울");

    await memory.flush();
    await memory.close();

    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    expect(saved.facts.length).toBe(1);
    expect(saved.episodes[0].consolidated).toBe(true);
  });

  it("leaves episodes unconsolidated for retry when extractor throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-consolidation-fail-"));
    dirs.push(dir);
    const storePath = join(dir, "store.json");
    writeFileSync(storePath, JSON.stringify(makeStoreFixture()));

    const factExtractor = vi.fn(async () => {
      throw new Error("LLM fact extraction failed with HTTP 404");
    });

    const onConsolidation = vi.fn();

    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      factExtractor,
      onConsolidation,
    });
    await memory.ready();

    const result = await memory.consolidate({ force: true });
    expect(result.phase).toBe("failed");
    if (result.phase === "failed") {
      expect(result.error).toContain("404");
    }
    expect(onConsolidation).toHaveBeenCalledWith(result);

    await memory.close();

    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    expect(saved.episodes[0].consolidated).toBe(false);
    expect(saved.facts.length).toBe(0);
  });

  it("waits on in-flight run during close and prevents store writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-consolidation-close-"));
    dirs.push(dir);
    const storePath = join(dir, "store.json");
    writeFileSync(storePath, JSON.stringify(makeStoreFixture()));

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let extractorCalled = false;
    const factExtractor = vi.fn(async () => {
      extractorCalled = true;
      await gate;
      return [
        {
          content: "사용자 거주지: 서울",
          entities: [],
          topics: ["p"],
          importance: 0.8,
          maxEmotion: 0,
          sourceEpisodeIds: ["ep-1"],
        },
      ];
    });

    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      factExtractor,
    });
    await memory.ready();

    const run = memory.consolidate({ force: true });
    await waitFor(() => extractorCalled, 5000);

    const closing = memory.close();
    releaseGate();
    await closing;

    const result = await run;
    expect(result.phase).toBe("failed");
    if (result.phase === "failed") {
      expect(result.error).toContain("memory closed");
    }

    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    expect(saved.facts.length).toBe(0);
    expect(saved.episodes[0].consolidated).toBe(false);
  });

  it("splits episode extraction into chunks of 10", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-consolidation-chunk-"));
    dirs.push(dir);
    const storePath = join(dir, "store.json");
    const now = Date.now();
    const episodes = Array.from({ length: 25 }, (_, i) => ({
      id: `ep-${i + 1}`,
      content: `나는 ${i + 1}번째 대화를 나눴어`,
      summary: "",
      role: "user" as const,
      timestamp: now - 60 * 60_000,
      importance: { importance: 0.8, surprise: 0, emotion: 0, utility: 0.8 },
      encodingContext: { project: "p" },
      consolidated: false,
      recallCount: 0,
      lastAccessed: now - 60 * 60_000,
      strength: 1,
    }));
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      episodes,
      facts: [],
      skills: [],
      reflections: [],
      associations: {},
    }));

    const factExtractor = vi.fn(async (eps: Episode[]) =>
      eps.map((ep) => ({
        content: `사실: ${ep.id}`,
        entities: [],
        topics: ["p"],
        importance: 0.8,
        maxEmotion: 0,
        sourceEpisodeIds: [ep.id],
      })),
    );

    const memory = makeNaiaMemory({
      project: "p",
      storePath,
      sessionId: "s1",
      factExtractor,
    });
    await memory.ready();

    const result = await memory.consolidate({ force: true });
    expect(result.phase).toBe("done");
    expect(factExtractor).toHaveBeenCalledTimes(3);
    expect(factExtractor.mock.calls[0][0].length).toBe(10);
    expect(factExtractor.mock.calls[1][0].length).toBe(10);
    expect(factExtractor.mock.calls[2][0].length).toBe(5);

    await memory.close();
  });

  it("verifies compose-agent-deps consolidation wiring contract", () => {
    const compose = readFileSync(new URL("../../scripts/builds/compose-agent-deps.mjs", import.meta.url), "utf8");
    expect(compose).toContain("NAIA_MEMORY_CONSOLIDATION");
    expect(compose).toContain("memory consolidation failed");
    expect(compose).toContain("consolidateOnSave: consolidationOn");
    expect(compose).toContain("nextMemoryRuntime?.ok");
  });
});

it("S-MEM-SAVE-026 composed completed turns extract immediately and recall after restart", async () => {
  const { createServer } = await import("node:http");
  const { mkdirSync } = await import("node:fs");
  // @ts-expect-error runtime composition MJS
  const { composeAgentRuntimeDeps } = await import("../../scripts/builds/compose-agent-deps.mjs");
  const { ChatTurnHandler } = await import("../main/app/chat-turn-handler.js");
  const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
  const { makeInMemoryCredentials } = await import("../main/composition/index.js");
  let extracts = 0, embeddings = 0, fail = false;
  const { OfflineEmbeddingProvider } = await import("@nextain/naia-memory");
  const vector = () => { embeddings++; return Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0); };
  const embed = vi.spyOn(OfflineEmbeddingProvider.prototype, "embed").mockImplementation(async () => vector());
  const batch = vi.spyOn(OfflineEmbeddingProvider.prototype, "embedBatch").mockImplementation(async (texts) => texts.map(vector));
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/embeddings")) {
      embeddings++;
      res.end(JSON.stringify({ data: (Array.isArray(body.input) ? body.input : [body.input]).map(() => ({ embedding: [1, 0, 0] })) }));
    } else {
      extracts++;
      if (fail) { res.statusCode = 503; res.end('{"error":"fixture unavailable"}'); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: '{"1":["사용자의 비밀 코드명은 MemoryCanary026이다"]}' } }] }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as import("node:net").AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  const dir = mkdtempSync(join(tmpdir(), "composed-memory-"));
  mkdirSync(join(dir, "naia-settings"));
  writeFileSync(join(dir, "naia-settings/config.json"), JSON.stringify({ provider: "fake", model: "test", llmRoles: { memory: { provider: "vllm", model: "qwen-test", baseUrl } }, memorySurfacingJudge: "threshold", memoryEmbeddingProvider: "offline", memoryOfflineModel: "all-MiniLM-L6-v2" }));
  const env = { NAIA_ADK_PATH: dir, AGENT_PROVIDER: "fake", NAIA_AGENT_SKILLS: "off", NAIA_AGENT_TRANSCRIPT: "off" };
  let deps = await composeAgentRuntimeDeps({ homeDir: dir, env });
  const events: unknown[] = [];
  const prompts: string[] = [];
  const approval = makeInMemoryApproval();
  const handler = () => new ChatTurnHandler({ defaultConfig: deps.defaultConfig, memory: deps.memory, surfacer: deps.surfacer, provider: { async *chat(_config, _messages, opts) { prompts.push(opts.systemPrompt ?? ""); yield { kind: "text", text: "알겠어" }; yield { kind: "finish" }; } }, conversation: { assemble: (r) => ({ messages: r.messages, systemPrompt: r.systemPrompt }) }, credentials: makeInMemoryCredentials(), approval, egress: { emit: (id, e) => { events.push(e); if (e.kind === "approvalRequest") queueMicrotask(() => approval.resolve(id, e.toolCallId, "approve")); } }, diag: { log() {} } });
  try {
    const a = handler();
    for (let n = 0; n < 4; n++) await a.onChatRequest({ kind: "chat", requestId: `A${n}`, sessionId: "A", messages: [{ role: "user", content: "내 비밀 코드명은 MemoryCanary026이야" }] });
    expect(extracts).toBe(4);
    expect(embeddings).toBeGreaterThan(0);
    const store = JSON.parse(readFileSync(join(dir, "naia-settings/memory/store.json"), "utf8"));
    expect(store.episodes).toHaveLength(8);
    expect(store.facts.length).toBeGreaterThan(0);
    await deps.memory.close();
    deps = await composeAgentRuntimeDeps({ homeDir: dir, env });
    expect((await deps.memory.recall("MemoryCanary026")).facts.join(" ")).toContain("MemoryCanary026");
    // A fresh OS process loads the same persisted facts (no process-local cache).
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const memoryUrl = new URL("../../dist/main/adapters/naia-memory.js", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { makeNaiaMemory } from ${JSON.stringify(memoryUrl)};
      const m = makeNaiaMemory({ storePath: ${JSON.stringify(join(dir, "naia-settings/memory/store.json"))}, project: ${JSON.stringify(store.episodes[0].encodingContext.project)}, sessionId: "B" });
      process.stdout.write(JSON.stringify(await m.recall("MemoryCanary026")));
      await m.close();
    `]);
    expect(JSON.parse(stdout).facts.join(" ")).toContain("MemoryCanary026");
    expect((await deps.reloadMemory(dir)).status).toContain("consolidation=on-save");
    // A remote failure must surface as a shell-readable warning, retaining the turn.
    fail = true;
    await handler().onChatRequest({ kind: "chat", requestId: "B", sessionId: "B", messages: [{ role: "user", content: "내 코드명을 기억해 줘" }] });
    expect(prompts.at(-1)).toContain("MemoryCanary026");
    expect(events).toContainEqual(expect.objectContaining({ kind: "logEntry", level: "warn", message: expect.stringContaining("MEMORY_EXTRACTION_FAILED") }));
  } finally {
    await deps.memory.close();
    for (const cleanup of [...deps.cleanupFns].reverse()) cleanup();
    await new Promise<void>((r, reject) => server.close((e) => e ? reject(e) : r()));
    embed.mockRestore(); batch.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("explicit consolidation off overrides a configured extractor; missing authorization preserves pending episodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "save-extraction-policy-"));
  const extract = vi.fn(async () => []);
  try {
    for (const enabled of [false, true]) {
      const storePath = join(dir, `${enabled}.json`);
      const memory = makeNaiaMemory({ project: "policy", storePath, consolidateOnSave: enabled, roleExtractor: extract });
      try {
        await memory.save("I like tea", "", enabled ? undefined : { authorizeAndDisclose: async () => true });
        await memory.flush();
        expect(extract).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(storePath, "utf8")).episodes[0].consolidated).toBe(false);
      } finally { await memory.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("immediate extraction failure reports its cause and retries fresh episodes on the next save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "save-extraction-retry-"));
  const events: MemoryConsolidationEvent[] = [];
  const extract = vi.fn().mockRejectedValueOnce(new Error("fixture extraction 503")).mockImplementation(async (episodes: Episode[]) => [{ content: "User likes tea", entities: [], topics: [], importance: 0.8, maxEmotion: 0, sourceEpisodeIds: [episodes[0].id] }]);
  const storePath = join(dir, "store.json");
  const memory = makeNaiaMemory({ project: "retry", storePath, consolidateOnSave: true, roleExtractor: extract, onConsolidation: (e) => events.push(e) });
  try {
    const onRoleError = vi.fn();
    await memory.save("I like tea", "", { authorizeAndDisclose: async () => true, onRoleError });
    await memory.flush();
    expect(onRoleError).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ phase: "failed", error: "fixture extraction 503" });
    expect(JSON.parse(readFileSync(storePath, "utf8")).episodes[0].consolidated).toBe(false);
    await memory.save("remember it", "", { authorizeAndDisclose: async () => true });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(storePath, "utf8")).facts).toHaveLength(1);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
