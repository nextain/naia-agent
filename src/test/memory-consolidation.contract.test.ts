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
    expect(compose).toContain("consolidation: {}");
    expect(compose).toContain("nextMemoryRuntime?.ok");
  });
});
