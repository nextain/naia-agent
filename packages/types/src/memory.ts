/**
 * MemoryProvider — long-term memory façade.
 *
 * Minimum contract: encode, recall, consolidate, close.
 * Optional behaviours exposed via Capability interfaces. Consumers check
 * capability at runtime; graceful degradation is the rule (A.11).
 *
 * Reference implementation: @nextain/alpha-memory.
 * See docs/memory-provider-audit.md for the façade → alpha-memory mapping.
 */

export interface MemoryInput {
  content: string;
  role: "user" | "assistant" | "tool";
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
  /** Implementation-defined score (strength, cosine similarity, ...). */
  score: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryProvider {
  encode(input: MemoryInput): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
  consolidate(): Promise<void>;
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

export interface KnowledgeGraphCapable {
  queryEntities(name: string): Promise<{ id: string; name: string; type?: string }[]>;
  queryRelations(fromEntityId: string, relation?: string): Promise<{ from: string; to: string; relation: string }[]>;
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

export interface ReconsolidationCapable {
  findContradictions(factId: string): Promise<{ conflictFactId: string; reason: string }[]>;
}

export interface TemporalCapable {
  applyDecay(): Promise<void>;
  recallWithHistory(query: string, atTimestamp?: number): Promise<MemoryHit[]>;
}

export interface SessionRecallCapable {
  sessionRecall(text: string, opts?: { topK?: number }): Promise<string | null>;
}

/**
 * Type guard — check if a MemoryProvider implementation also implements a Capability.
 *
 * @example
 *   if (isCapable<BackupCapable>(memory, "backup")) {
 *     const blob = await memory.backup();
 *   }
 */
export function isCapable<C>(
  provider: MemoryProvider,
  method: keyof C,
): provider is MemoryProvider & C {
  return typeof (provider as unknown as Record<string, unknown>)[method as string] === "function";
}
