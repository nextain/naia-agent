/**
 * naia-memory-host — runs Agent against the **real** @nextain/naia-memory.
 *
 * This closes the loop: the CompactableCapable contract defined in
 * @nextain/agent-types was just proven against CompactableMemory (mock);
 * here we verify naia-memory's real MemorySystem.compact() also matches
 * the contract structurally.
 *
 * No external services required — naia-memory's LocalAdapter runs
 * in-process with an in-memory SQLite.
 *
 * Run: pnpm exec tsx examples/naia-memory-host.ts
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@nextain/agent-core";
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
} from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import {
  InMemoryToolExecutor,
  MockLLMClient,
} from "@nextain/agent-runtime";

import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

/**
 * Adapter that wires naia-memory's `MemorySystem` to the MemoryProvider +
 * CompactableCapable shapes naia-agent expects.
 *
 * Type mismatches handled here:
 *   - MemoryInput.context: naia-agent uses Record<string,string>, alpha
 *     uses string. We serialize.
 *   - recall(): alpha returns `Episode[]`, we map to `MemoryHit[]` and
 *     normalize score to [0, 1] from `strength`.
 */
class AlphaMemoryAdapter implements MemoryProvider, CompactableCapable {
  readonly #sys: MemorySystem;

  constructor(sys: MemorySystem) {
    this.#sys = sys;
  }

  async encode(input: MemoryInput): Promise<void> {
    const contextStr = input.context
      ? Object.entries(input.context)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : undefined;
    // Unpack selected context keys into naia-memory's EncodingContext
    // object so features like rolling-summary-per-session can activate.
    const encodingContext: {
      sessionId?: string;
      project?: string;
      activeFile?: string;
      taskDescription?: string;
    } = {};
    if (input.context?.["sessionId"]) encodingContext.sessionId = input.context["sessionId"];
    if (input.context?.["project"]) encodingContext.project = input.context["project"];
    if (input.context?.["activeFile"]) encodingContext.activeFile = input.context["activeFile"];
    if (input.context?.["taskDescription"]) encodingContext.taskDescription = input.context["taskDescription"];
    await this.#sys.encode(
      {
        content: input.content,
        role: input.role,
        ...(contextStr !== undefined ? { context: contextStr } : {}),
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      },
      encodingContext,
    );
  }

  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
    const result = await this.#sys.recall(query, {
      topK: opts?.topK ?? 5,
      ...(opts?.minStrength !== undefined ? { minStrength: opts.minStrength } : {}),
      ...(opts?.deepRecall !== undefined ? { deepRecall: opts.deepRecall } : {}),
    });
    // naia-memory recall may return [] or undefined depending on adapter;
    // coerce to array before mapping.
    const episodes = Array.isArray(result) ? result : [];
    return episodes.map<MemoryHit>((e) => ({
      id: e.id,
      content: e.content,
      summary: e.summary,
      score: clamp01(e.strength ?? 1),
      timestamp: e.timestamp,
    }));
  }

  async consolidate(): Promise<ConsolidationSummary> {
    const t0 = Date.now();
    const result = await this.#sys.consolidateNow(true);
    return {
      factsCreated: result.factsCreated,
      durationMs: Date.now() - t0,
    };
  }

  async compact(input: CompactionInput): Promise<CompactionResult> {
    // naia-memory's compact() is structurally compatible with
    // CompactableCapable.compact() — we forward directly.
    const result = await this.#sys.compact({
      messages: input.messages.map((m) => {
        const out: { role: string; content: string; timestamp?: number } = {
          role: m.role,
          content: m.content,
        };
        if (m.timestamp !== undefined) out.timestamp = m.timestamp;
        return out;
      }),
      keepTail: input.keepTail,
      targetTokens: input.targetTokens,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    // Re-cast the summary's role from string → literal "assistant" so the
    // TypeScript compiler accepts the return type.
    const summary: CompactionResult["summary"] = {
      role: "user", // placeholder; overwritten below
      content: result.summary.content,
    };
    if (result.summary.timestamp !== undefined) summary.timestamp = result.summary.timestamp;
    (summary as { role: "assistant" | "user" | "tool" }).role = result.summary.role as "assistant" | "user" | "tool";
    return {
      summary,
      droppedCount: result.droppedCount,
      realtime: result.realtime,
    };
  }

  async close(): Promise<void> {
    await this.#sys.close();
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "naia-alpha-mem-smoke-"));
  const dbPath = join(tmp, "memory.json");

  try {
    // Opt-in LLM-backed summarizer (alpha-memory v1 hook).
    // A separate MockLLMClient is dedicated to summarization so its call
    // count is independent from the main agent's LLM.
    const useLlmSummarizer = process.env["ALPHA_MEMORY_LLM_SUMMARIZER"] === "1";
    const summarizerLlm = new MockLLMClient({
      turns: [
        {
          blocks: "[SUMMARY via dedicated LLM] earlier exchange folded into a single assistant turn.",
          stopReason: "end_turn",
        },
      ],
    });
    const summarizer = useLlmSummarizer
      ? async (input: {
          messages: readonly { role: string; content: string; timestamp?: number }[];
          keepTail: number;
          targetTokens: number;
          seedSummary: string;
        }) => {
          // Actually call the LLM. Real hosts wrap their own LLMClient here.
          const response = await summarizerLlm.generate({
            messages: [
              {
                role: "user",
                content: `Summarize the prior conversation. Seed: ${input.seedSummary}`,
              },
            ],
            maxTokens: input.targetTokens,
          });
          const text = response.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
          return text;
        }
      : undefined;

    const sysOptions: ConstructorParameters<typeof MemorySystem>[0] = {
      adapter: new LocalAdapter(dbPath),
      consolidationIntervalMs: 60_000 * 60, // never auto during smoke
    };
    if (summarizer) sysOptions.summarizer = summarizer;
    const sys = new MemorySystem(sysOptions);
    const memory = new AlphaMemoryAdapter(sys);

    const llm = new MockLLMClient({
      turns: [
        { blocks: "Short reply.", stopReason: "end_turn" },
        { blocks: "Second reply referencing context.", stopReason: "end_turn" },
      ],
    });

    const host: HostContext = {
      llm,
      memory,
      tools: new InMemoryToolExecutor(),
      logger: new ConsoleLogger({ level: "info" }),
      tracer: new NoopTracer(),
      meter: new InMemoryMeter(),
      approvals: {
        async decide() {
          throw new Error("not wired");
        },
      },
      identity: {
        deviceId: randomUUID(),
        publicKeyEd25519: "mock",
        async sign() {
          throw new Error("not wired");
        },
      },
    };

    const agent = new Agent({
      host,
      contextBudget: 200,
      compactionKeepTail: 1,
    });

    const longText = "Please summarize: " + "alpha beta gamma ".repeat(150);
    let compactedEvents = 0;
    let lastCompactionRealtime: boolean | undefined;

    for await (const ev of agent.sendStream(longText)) {
      if (ev.type === "compaction") {
        compactedEvents++;
        lastCompactionRealtime = ev.realtime;
      }
    }
    for await (const ev of agent.sendStream("Follow-up")) {
      if (ev.type === "compaction") {
        compactedEvents++;
        lastCompactionRealtime = ev.realtime;
      }
    }

    // Snapshot BEFORE cleanup so the assertion below can see the tracked
    // session. clearRollingSummary releases the map entry so long-running
    // hosts don't leak per-session entries.
    const snapshotsBeforeClose = sys.snapshotRollingSummaries();
    sys.clearRollingSummary(agent.session.id);
    await memory.close();
    agent.close();

    console.log("\n━━━ naia-memory smoke results ━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  compaction events: ${compactedEvents}`);
    console.log(`  last realtime flag: ${lastCompactionRealtime}`);

    if (compactedEvents === 0) {
      console.error("FAIL: compact() was never exercised");
      process.exit(1);
    }
    // With a sessionId flowing into encode() (via Agent → context), the
    // rolling summary path activates and compact() returns realtime=true.
    if (lastCompactionRealtime !== true) {
      console.error(
        `FAIL: expected realtime=true once a sessionId is encoded (v2 rolling summary), got ${lastCompactionRealtime}`,
      );
      process.exit(1);
    }

    const snapshotsAfterClose = sys.snapshotRollingSummaries();
    console.log(`  rolling summaries pre-close:  ${snapshotsBeforeClose.length}`);
    console.log(`  rolling summaries post-close: ${snapshotsAfterClose.length}`);
    if (snapshotsBeforeClose.length === 0) {
      console.error("FAIL: expected at least one rolling summary snapshot before close");
      process.exit(1);
    }
    if (snapshotsAfterClose.length !== 0) {
      console.error("FAIL: clearRollingSummary should have released the entry");
      process.exit(1);
    }

    // Durability round-trip — snapshot → load → snapshot should preserve shape.
    sys.loadRollingSummaries(snapshotsBeforeClose);
    const restored = sys.snapshotRollingSummaries();
    if (restored.length !== snapshotsBeforeClose.length) {
      console.error(
        `FAIL: loadRollingSummaries should restore ${snapshotsBeforeClose.length} entries, got ${restored.length}`,
      );
      process.exit(1);
    }
    if (
      restored[0]?.sessionId !== snapshotsBeforeClose[0]?.sessionId ||
      restored[0]?.userCount !== snapshotsBeforeClose[0]?.userCount
    ) {
      console.error("FAIL: restored rolling summary differs from snapshot");
      process.exit(1);
    }
    console.log(`  durability round-trip: ✓`);

    console.log("\n✓ naia-memory v2 rolling summary + lifecycle + durability confirmed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
