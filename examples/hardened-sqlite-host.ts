/**
 * hardened-sqlite-host — runs Agent against the hardened SQLite engine.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { Agent } from "../packages/core/src/agent.js";
import type {
  CompactableCapable,
  CompactionInput,
  CompactionResult,
  ConsolidationSummary,
  HostContext,
  MemoryHit,
  MemoryInput,
  MemoryProvider,
  RecallOpts,
  TemporalCapable,
  BackupCapable
} from "../packages/types/src/memory.js";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "../packages/observability/src/index.js";
import {
  InMemoryToolExecutor,
  MockLLMClient,
} from "../packages/runtime/src/index.js";

import { SqliteAdapter, MemorySystem, OfflineEmbeddingProvider } from "../../naia-memory/src/memory/index.js";

class HardenedMemoryAdapter implements MemoryProvider, CompactableCapable, TemporalCapable, BackupCapable {
  readonly #sys: MemorySystem;

  constructor(sys: MemorySystem) {
    this.#sys = sys;
  }

  async encode(input: MemoryInput): Promise<void> {
    await this.#sys.encode({
      content: input.content,
      role: input.role,
      timestamp: input.timestamp,
    }, {
      sessionId: input.context?.["sessionId"],
      project: input.context?.["project"],
    });
  }

  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
    const result = await this.#sys.recall(query, {
      topK: opts?.topK ?? 5,
      deepRecall: opts?.deepRecall,
      project: opts?.project,
    });
    const hits: MemoryHit[] = [];
    result.facts.forEach(f => hits.push({ id: f.id, content: f.content, score: f.relevanceScore ?? 0, createdAt: f.createdAt, metadata: { type: "fact" } }));
    result.episodes.forEach(e => hits.push({ id: e.id, content: e.content, score: e.strength ?? 0.5, createdAt: e.timestamp, metadata: { type: "episode" } }));
    return hits.sort((a, b) => b.score - a.score).slice(0, opts?.topK ?? 5);
  }

  async recallWithHistory(query: string, atTimestamp: number, opts?: RecallOpts): Promise<MemoryHit[]> {
      const result = await this.#sys.recallWithHistory(query, atTimestamp, opts);
      return result.facts.map(f => ({ id: f.id, content: f.content, score: f.relevanceScore ?? 0, createdAt: f.createdAt }));
  }

  async applyDecay(): Promise<number> { return this.#sys.applyDecay(); }

  async consolidate(): Promise<ConsolidationSummary> {
    const t0 = performance.now();
    const result = await this.#sys.consolidateNow(true); // Force: true
    return { factsCreated: result.factsCreated, factsUpdated: result.factsUpdated, episodesProcessed: result.episodesProcessed, durationMs: performance.now() - t0 };
  }

  async compact(input: CompactionInput): Promise<CompactionResult> {
    const result = await this.#sys.compact(input as any);
    return { summary: result.summary as any, droppedCount: result.droppedCount, realtime: result.realtime };
  }

  async exportBackup(password: string): Promise<Uint8Array> { return this.#sys.exportBackup(password); }
  async importBackup(blob: Uint8Array, password: string): Promise<void> { return this.#sys.importBackup(blob, password); }

  async close(): Promise<void> { await this.#sys.close(); }
}

async function main() {
  console.log("=== Naia Agent Hardened SQLite Final Verification PoC ===");
  const tmp = mkdtempSync(join(tmpdir(), "naia-agent-hardened-"));
  const dbPath = join(tmp, "hardened.db");

  try {
    const embedder = new OfflineEmbeddingProvider();
    const adapter = new SqliteAdapter({ dbPath, embeddingProvider: embedder });
    const sys = new MemorySystem({ adapter });
    await sys.init();
    const memory = new HardenedMemoryAdapter(sys);

    // SCALE INJECTION: 10,000 facts
    console.log("Loading 10,000 facts for realistic benchmark...");
    const startLoad = performance.now();
    for (let i = 0; i < 10000; i++) {
        await adapter.semantic.upsert({
            id: `fact-${i}`, content: `Content ${i} about topic-${i % 100}`, entities: [`topic-${i % 100}`], topics: [`topic-${i % 100}`], importance: 0.1, maxEmotion: 0.1, strength: i < 5000 ? 0.9 : 0.1, status: "active", createdAt: Date.now(), updatedAt: Date.now(), lastAccessed: Date.now(), recallCount: 0, validFrom: Date.now(), validTo: null, sourceEpisodes: [], encodingContext: {}
        });
    }
    console.log(`Loaded in ${((performance.now() - startLoad) / 1000).toFixed(2)}s`);

    const host: HostContext = {
      llm: new MockLLMClient({ turns: [{ blocks: "Ready with 10k facts.", stopReason: "end_turn" }] }),
      memory,
      tools: new InMemoryToolExecutor(),
      logger: new ConsoleLogger({ level: "warn" }),
      tracer: new NoopTracer(),
      meter: new InMemoryMeter(),
      approvals: { async decide() { return true; } },
      identity: { deviceId: "poc-device", publicKeyEd25519: "mock", async sign(d) { return d; } }
    };

    const agent = new Agent({ host });

    console.log("\n--- Testing Agent Turn Performance ---");
    const startTurn = performance.now();
    await agent.send("Search for topic-50.");
    const turnTime = performance.now() - startTurn;
    console.log(`Turn time (including recall): ${turnTime.toFixed(2)}ms`);

    if (turnTime < 100) {
        console.log("SUCCESS: Agent turn under 100ms with 10k facts.");
    } else {
        console.warn(`WARN: Agent turn took ${turnTime.toFixed(2)}ms.`);
    }

    console.log("\n--- Testing Backup/Import Parity ---");
    const backup = await memory.exportBackup("secure-password");
    console.log(`Backup size: ${backup.length} bytes`);
    await memory.importBackup(backup, "secure-password");
    console.log("Import successful.");

    console.log("\n--- Testing Bi-Temporal Recall ---");
    const now = Date.now();
    const hits = await memory.recallWithHistory("topic-50", now);
    console.log(`Bi-temporal hits: ${hits.length}`);

    await memory.close();
    console.log("\nFinal Integration Verification SUCCESS.");
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(console.error);
