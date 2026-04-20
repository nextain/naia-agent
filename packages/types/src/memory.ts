/**
 * MemoryProvider — long-term memory façade.
 *
 * Minimum contract: encode, recall, consolidate, close.
 * Optional behaviours exposed via Capability interfaces. Consumers check
 * capability at runtime; graceful degradation is the rule (A.11).
 *
 * Reference implementation: @nextain/alpha-memory.
 * See docs/memory-provider-audit.md for the façade → alpha-memory mapping.
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
