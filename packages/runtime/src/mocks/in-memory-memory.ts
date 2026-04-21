import type {
  MemoryHit,
  MemoryInput,
  MemoryProvider,
  RecallOpts,
  ConsolidationSummary,
} from "@nextain/agent-types";

/**
 * InMemoryMemory — dead-simple MemoryProvider for tests, examples, and
 * hosts that do not need persistence. Keeps a FIFO list of encoded inputs
 * and returns naive substring-match recall.
 *
 * Does NOT implement any Capability (BackupCapable, CompactableCapable,
 * ...) — that is the point. Lets Agent exercise the graceful-degradation
 * paths. Plug alpha-memory in when you need the real thing.
 */
export class InMemoryMemory implements MemoryProvider {
  readonly #records: { id: string; content: string; role: string; ts: number }[] = [];

  async encode(input: MemoryInput): Promise<void> {
    this.#records.push({
      id: `mem-${this.#records.length + 1}`,
      content: input.content,
      role: input.role,
      ts: input.timestamp ?? Date.now(),
    });
  }

  async recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]> {
    const topK = opts?.topK ?? 5;
    const q = query.toLowerCase();
    const scored = this.#records
      .map((r) => ({
        record: r,
        score: r.content.toLowerCase().includes(q) ? 1 : 0,
      }))
      .filter((s) => s.score > 0)
      .slice(-topK);

    return scored.map<MemoryHit>((s) => ({
      id: s.record.id,
      content: s.record.content,
      score: s.score,
      timestamp: s.record.ts,
    }));
  }

  async consolidate(): Promise<ConsolidationSummary> {
    return { factsCreated: 0, durationMs: 0 };
  }

  async close(): Promise<void> {
    this.#records.length = 0;
  }

  /** Testing helper — inspect raw records. Not part of MemoryProvider contract. */
  snapshot(): readonly { id: string; content: string; role: string; ts: number }[] {
    return this.#records;
  }
}
