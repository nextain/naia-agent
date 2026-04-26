/**
 * MemoryProvider — long-term memory façade.
 *
 * Minimum contract: encode, recall, consolidate, close.
 * Optional behaviours exposed via Capability interfaces. Consumers check
 * capability at runtime; graceful degradation is the rule (A.11).
 *
 * Reference implementation: @nextain/naia-memory.
 * See docs/memory-provider-audit.md for the façade → naia-memory mapping.
 *
 * Score semantics (MemoryHit.score): implementations SHOULD normalize to
 * [0, 1] where 1 = strongest match. Raw strength or cosine distance must be
 * normalized before returning.
 */

export type MemoryRole = "user" | "assistant" | "tool";

export interface MemoryInput {
  content: string;
  role: MemoryRole;
  /** Optional context hints (project, activeFile, sessionId, ...). */
  context?: Record<string, string>;
  /** Optional timestamp override (useful for ingesting historical data). */
  timestamp?: number;
}

export interface RecallOpts {
  topK?: number;
  minStrength?: number;
  /** Ignore decay weighting; retrieve from deep long-term store. */
  deepRecall?: boolean;
  /** Optional context hints for context-dependent recall. */
  context?: Record<string, string>;
}

export interface MemoryHit {
  id: string;
  content: string;
  summary?: string;
  /** Normalized 0..1 match score. 1 = strongest. */
  score: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface ConsolidationSummary {
  /** How many new facts were extracted. */
  factsCreated: number;
  /** Milliseconds spent. */
  durationMs: number;
}

export interface MemoryProvider {
  encode(input: MemoryInput): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
  /** Returns a summary so hosts can emit Event.data for observability. */
  consolidate(): Promise<ConsolidationSummary>;
  close(): Promise<void>;
}

// ─── Optional Capabilities ───────────────────────────────────────────────────
// Implementations implement the ones they support; consumers check via
// isCapable() before using.

export interface BackupCapable {
  backup(): Promise<Uint8Array>;
  restore(data: Uint8Array): Promise<void>;
}

export interface EmbeddingCapable {
  embed(text: string): Promise<number[]>;
}

export interface Entity {
  id: string;
  name: string;
  type?: string;
}

export interface Relation {
  from: string;
  to: string;
  relation: string;
}

export interface KnowledgeGraphCapable {
  queryEntities(name: string): Promise<Entity[]>;
  queryRelations(fromEntityId: string, relation?: string): Promise<Relation[]>;
}

export interface ImportanceScore {
  importance: number;
  surprise: number;
  emotion: number;
  utility: number;
}

export interface ImportanceCapable {
  scoreImportance(input: MemoryInput): Promise<ImportanceScore>;
}

export interface Contradiction {
  conflictFactId: string;
  reason: string;
}

export interface ReconsolidationCapable {
  findContradictions(factId: string): Promise<Contradiction[]>;
}

export interface TemporalCapable {
  applyDecay(): Promise<void>;
  recallWithHistory(query: string, atTimestamp?: number): Promise<MemoryHit[]>;
}

export interface SessionRecallCapable {
  sessionRecall(text: string, opts?: { topK?: number }): Promise<string | null>;
}

/**
 * `CompactableCapable` — memory-assisted context compaction.
 *
 * Consumed by the agent loop when the LLM context approaches its budget.
 * Memory implementations that know the full conversation (via prior
 * `encode` calls) can produce a semantic summary that replaces a window of
 * raw messages, preserving meaning while shrinking tokens.
 *
 * Real-time variant: a future naia-memory version may maintain a rolling
 * summary during `encode` calls so `compact()` returns instantly. The
 * contract allows both on-demand and pre-computed strategies — callers
 * should not assume compact() is cheap.
 */
export interface CompactableCapable {
  compact(input: CompactionInput): Promise<CompactionResult>;
}

export interface CompactionInput {
  /**
   * The message window to compact. Usually the leading N turns of a
   * conversation, excluding the tail that is kept verbatim.
   * Implementation-opaque — concrete shape is defined by caller.
   */
  messages: readonly CompactionMessage[];
  /** How many raw messages from the end of the original transcript will be
   *  preserved by the caller. Informational — lets memory shape summary. */
  keepTail: number;
  /** Rough target token budget for the returned summary. */
  targetTokens: number;
  /** Optional session id for context continuity. */
  sessionId?: string;
}

/**
 * Minimum wire shape for a message in compaction input. Callers map their
 * native message type (e.g. `LLMMessage`) into this. Kept separate from
 * `LLMMessage` to avoid a cross-file dependency inside types.
 */
export interface CompactionMessage {
  role: "user" | "assistant" | "tool";
  /** Text representation of the message. Tool-use and structured content
   *  are serialized by the caller before passing here. */
  content: string;
  /** Optional timestamp for temporal reasoning. */
  timestamp?: number;
}

export interface CompactionResult {
  /** The summary message — role is always "assistant" (meta-narration). */
  summary: CompactionMessage;
  /** How many of the input messages were subsumed by the summary. */
  droppedCount: number;
  /** Whether the summary was pre-computed (cheap) or freshly generated. */
  realtime?: boolean;
}

/**
 * Type guard — check if a MemoryProvider also implements a Capability.
 *
 * Multi-method capabilities (like BackupCapable with both backup + restore)
 * require all methods present. Supply an array to enforce this.
 *
 * **CAVEAT**: This is structural duck-typing — only method **presence** is
 * verified, not signature. An implementation with `backup(x: number): void`
 * still passes `isCapable<BackupCapable>`. Implementations declaring a
 * capability are expected to honor the contract; shape mismatches surface
 * as runtime errors, not compile-time errors.
 *
 * @example
 *   if (isCapable<BackupCapable>(memory, ["backup", "restore"])) {
 *     const blob = await memory.backup();
 *   }
 */
export function isCapable<C>(
  provider: MemoryProvider,
  methods: keyof C | readonly (keyof C)[],
): provider is MemoryProvider & C {
  const list = Array.isArray(methods) ? methods : [methods as keyof C];
  const record = provider as unknown as Record<string, unknown>;
  return list.every((m) => typeof record[m as string] === "function");
}
