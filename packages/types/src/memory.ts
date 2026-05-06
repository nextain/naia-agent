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
  /** Project scope filter. When set, only memories tagged for this project
   *  are eligible. naia-memory uses this for `encodingContext.project` /
   *  `topics.includes(project)`. (R2.5 alignment with naia-memory) */
  project?: string;
  /** Session continuity hint. Implementations may bias recall toward the
   *  same session's prior memories. (R2.5 alignment) */
  sessionId?: string;
}

export interface MemoryHit {
  id: string;
  content: string;
  summary?: string;
  /** Normalized 0..1 match score. 1 = strongest. */
  score: number;
  /** When the underlying memory was first created. Implementations SHOULD
   *  populate this; old code paths use `timestamp` as a fallback alias. */
  createdAt?: number;
  /** When the memory was last updated (reconsolidation, supersede, …). */
  updatedAt?: number;
  /** Deprecated alias for `createdAt`. Kept for backward compatibility. */
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface ConsolidationSummary {
  /** How many new facts were extracted. */
  factsCreated: number;
  /** How many existing facts were updated (reconsolidation / supersede).
   *  Optional — old implementations may not populate. (R2.5 alignment) */
  factsUpdated?: number;
  /** How many episodes were processed during this consolidation cycle.
   *  Optional. (R2.5 alignment) */
  episodesProcessed?: number;
  /** Milliseconds spent. */
  durationMs: number;
}

/** Optional encode-time hints (project tag, etc.). (R2.5 alignment) */
export interface EncodeOpts {
  /** Project tag attached to the resulting memory's encoding context. */
  project?: string;
}

export interface MemoryProvider {
  encode(input: MemoryInput, opts?: EncodeOpts): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
  /** Returns a summary so hosts can emit Event.data for observability. */
  consolidate(): Promise<ConsolidationSummary>;
  close(): Promise<void>;
}

// ─── Optional Capabilities ───────────────────────────────────────────────────
// Implementations implement the ones they support; consumers check via
// isCapable() before using.

/**
 * Encrypted backup capability — AES-256-GCM with PBKDF2-derived key.
 * (R2.5 alignment — adopts naia-memory's password-protected scheme.)
 *
 * Implementations that don't need encryption may pass an empty password
 * but the parameter is required by the contract for forward compatibility.
 */
export interface BackupCapable {
  exportBackup(password: string): Promise<Uint8Array>;
  importBackup(blob: Uint8Array, password: string): Promise<void>;
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
  /** ID of the existing fact that conflicts with the new content. */
  conflictingId: string;
  /** Direct = same entity/attribute replaced. Indirect = related fact reframed. */
  conflictType: "direct" | "indirect";
  reason: string;
}

export interface ReconsolidationCapable {
  /**
   * Detect contradictions between *new content* and stored facts.
   *
   * (R2.5 alignment — naia-memory's signature: caller supplies the new
   * content directly, optionally restricted to specific existing fact IDs.
   * Returns enriched verdicts including conflict type.)
   */
  findContradictions(
    newContent: string,
    existingIds?: readonly string[],
  ): Promise<Contradiction[]>;
}

export interface TemporalCapable {
  /** Run an Ebbinghaus-style decay sweep. Returns the count of pruned items
   *  (R2.5 alignment — naia-memory returns the count, not void). */
  applyDecay(): Promise<number>;
  /**
   * Bi-temporal recall — return memories valid at the given timestamp.
   *
   * (R2.5 alignment — naia-memory makes `atTimestamp` required and accepts
   * the same opts shape as `recall`. Implementations leverage the
   * `-v{ts}/superseded` versioning scheme to surface the version that was
   * active at the queried point in time.)
   */
  recallWithHistory(
    query: string,
    atTimestamp: number,
    opts?: RecallOpts,
  ): Promise<MemoryHit[]>;
}

// ─── ContradictionFilter (R2.5 — dual-process retrieval-rerank) ──────────────

/** Pair of an existing memory and an incoming statement, evaluated by a
 *  `ContradictionFilterCapable` provider for actual contradiction. */
export interface ContradictionCandidate {
  existing: { id: string; content: string; entities?: readonly string[] };
  newInfo: string;
}

/** Per-pair verdict from the filter. \`confidence\` is 0–1; consumers may
 *  threshold (default ≥0.7 in naia-memory) before acting on the verdict. */
export interface ContradictionVerdict {
  /** Index into the input candidates array (preserved for caller correlation). */
  index: number;
  action: "update" | "flag" | "keep";
  /** New content to install when `action === "update"`. */
  updatedContent?: string;
  reason: string;
  confidence: number;
}

/**
 * Optional capability — small-LLM (or heuristic) filter that decides which
 * of a *broad candidate set* (entity/cosine match) are *actual*
 * contradictions. Mirrors human ACC (conflict detection) → PFC (resolution)
 * division of labour; see naia-memory `contradiction-filter.ts` for the
 * dual-process / asymmetric-model-sizing rationale.
 *
 * Implementations: \`HeuristicContradictionFilter\` (offline default),
 * \`GeminiFlashLiteContradictionFilter\` (cloud), \`VllmReasoningContradictionFilter\`
 * (local Gemma via vLLM). Selection by env: \`VLLM_REASONING_BASE > GEMINI_API_KEY > heuristic\`.
 */
export interface ContradictionFilterCapable {
  filterContradictions(
    candidates: readonly ContradictionCandidate[],
  ): Promise<ContradictionVerdict[]>;
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
 *   if (isCapable<BackupCapable>(memory, ["exportBackup", "importBackup"])) {
 *     const blob = await memory.exportBackup(password);
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
