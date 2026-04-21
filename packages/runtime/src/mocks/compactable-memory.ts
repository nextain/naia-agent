import type {
  CompactableCapable,
  CompactionInput,
  CompactionMessage,
  CompactionResult,
  MemoryHit,
  MemoryInput,
  MemoryProvider,
  RecallOpts,
  ConsolidationSummary,
} from "@nextain/agent-types";

/**
 * CompactableMemory — MemoryProvider that **also** implements
 * CompactableCapable. Use this to exercise the Agent's compaction path
 * and verify that CompactableCapable's shape is consumable.
 *
 * The compaction strategy is intentionally simple (head-truncation with
 * a 1-line summary of what was dropped). A real alpha-memory
 * implementation will do semantic summarization — either on-demand via
 * an injected LLM or, in a later version, from a rolling summary
 * maintained incrementally during `encode()`.
 */
export class CompactableMemory implements MemoryProvider, CompactableCapable {
  readonly #records: { id: string; content: string; role: string; ts: number }[] = [];
  #compactCallCount = 0;

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
    return this.#records
      .filter((r) => r.content.toLowerCase().includes(q))
      .slice(-topK)
      .map<MemoryHit>((r) => ({
        id: r.id,
        content: r.content,
        score: 1,
        timestamp: r.ts,
      }));
  }

  async consolidate(): Promise<ConsolidationSummary> {
    return { factsCreated: 0, durationMs: 0 };
  }

  async close(): Promise<void> {
    this.#records.length = 0;
  }

  /**
   * Implements CompactableCapable.compact().
   *
   * Minimum viable summarization: counts roles, picks first+last utterance
   * from the window, produces a synthetic summary message. Good enough to
   * verify the contract round-trips. Real impls should use an LLM.
   */
  async compact(input: CompactionInput): Promise<CompactionResult> {
    this.#compactCallCount++;
    const msgs = input.messages;
    const userTurns = msgs.filter((m) => m.role === "user").length;
    const assistantTurns = msgs.filter((m) => m.role === "assistant").length;
    const toolTurns = msgs.filter((m) => m.role === "tool").length;

    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    const firstPreview = first ? truncate(first.content, 80) : "(empty)";
    const lastPreview = last ? truncate(last.content, 80) : "(empty)";

    const summaryText = [
      `[Compaction summary — ${msgs.length} messages dropped, ${input.keepTail} kept]`,
      `Roles: ${userTurns} user · ${assistantTurns} assistant · ${toolTurns} tool`,
      `First: "${firstPreview}"`,
      `Last: "${lastPreview}"`,
      `Target budget: ${input.targetTokens} tokens.`,
    ].join("\n");

    const summary: CompactionMessage = {
      role: "assistant",
      content: summaryText,
      timestamp: Date.now(),
    };

    return {
      summary,
      droppedCount: msgs.length,
      realtime: false,
    };
  }

  /** Test helper — how many times compact() has been invoked. */
  get compactCallCount(): number {
    return this.#compactCallCount;
  }

  snapshot(): readonly { id: string; content: string; role: string; ts: number }[] {
    return this.#records;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
