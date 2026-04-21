# MemoryProvider Audit — alpha-memory mapping

**Status**: MVM #1 deliverable (first-round audit, not the final interface).
**Source**: `nextain/alpha-memory@bd2ad3b` (main). Exports inspected directly from `src/memory/index.ts`, `src/memory/types.ts`, `src/memory/adapters/`.
**Goal**: draft `MemoryProvider` façade that reduces alpha-memory's surface to the minimal cross-implementation contract defined in the 4-repo migration plan (Part A.5).

## 1. Current alpha-memory surface

### Top-level class: `MemorySystem` (orchestrator)

Public methods (relevant to façade):

| Method | Signature | Role |
|---|---|---|
| `encode` | `(input: MemoryInput, context?: EncodingContext) → Promise<Episode \| null>` | Importance-gated storage into episodic store |
| `recall` | `(query: string, context?: RecallContext) → Promise<Episode[]>` | Context-dependent retrieval with decay weighting |
| `consolidate` | `() → Promise<ConsolidationResult>` | Episodic → semantic via fact extraction |
| `sessionRecall` | `(text: string, opts?: { topK? }) → Promise<string \| null>` | Formatted context block for LLM injection |
| `close` | `() → Promise<void>` | Cleanup resources |
| `startConsolidation` | `() → void` | Background consolidation loop |

### Lower abstraction: `MemoryAdapter` (pluggable backend)

Interface signatures (`src/memory/types.ts`):

- `addEpisode`, `addFact`, `addSkill`, `addReflection`
- `searchEpisodes`, `searchFacts`, `searchSkills`
- `getEpisodesByIds`, update, delete variants
- `close`

### Supporting types

- `MemoryInput` — `{ content, role, context?, timestamp? }`
- `Episode` — id, content, summary, timestamp, importance, encodingContext, consolidated, recallCount, lastAccessed, strength
- `Fact`, `Skill`, `Reflection`
- `RecallContext` — project, activeFile, topK, minStrength, deepRecall
- `ImportanceScore` — importance × surprise × emotion → utility
- `BackupCapable` (already a capability interface in alpha-memory)

### Existing adapters

- `LocalAdapter` — SQLite + hnswlib
- `QdrantAdapter` — remote vector DB

### Embedding abstraction

- `EmbeddingProvider` interface
- Implementations: `OfflineEmbeddingProvider`, `OpenAICompatEmbeddingProvider`, `NaiaGatewayEmbeddingProvider`

## 2. Proposed `MemoryProvider` façade (for `@naia-agent/types`)

Minimum surface — matches A.5 contract (`encode`, `recall`, `consolidate`, `close`) with alpha-memory mapping:

```typescript
// @naia-agent/types (zero runtime deps)

export interface MemoryProvider {
  encode(input: MemoryInput): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
  consolidate(): Promise<void>;
  close(): Promise<void>;
}

export interface MemoryInput {
  content: string;
  role: "user" | "assistant" | "tool";
  context?: Record<string, string>;  // project, activeFile, sessionId, ...
  timestamp?: number;
}

export interface RecallOpts {
  topK?: number;
  minStrength?: number;
  deepRecall?: boolean;          // Alpha feature — gracefully ignored by impls that lack it
  context?: Record<string, string>;
}

export interface MemoryHit {
  id: string;
  content: string;
  summary?: string;
  score: number;                  // implementation-defined (strength, cosine, etc.)
  timestamp?: number;
  metadata?: Record<string, unknown>;
}
```

### Mapping to alpha-memory

| Façade method | alpha-memory call | Notes |
|---|---|---|
| `encode(input)` | `memorySystem.encode(input, input.context)` | Importance gating happens inside alpha-memory |
| `recall(query, opts)` | `memorySystem.recall(query, opts)` → map `Episode[]` → `MemoryHit[]` | Episode.strength → hit.score |
| `consolidate()` | `memorySystem.consolidate()` | Drop `ConsolidationResult` to `void`; caller inspects logs |
| `close()` | `memorySystem.close()` | Direct pass-through |

## 3. Optional Capability interfaces (A.5)

Alpha-memory features that belong in optional capabilities, not the minimum façade:

```typescript
export interface BackupCapable {
  backup(): Promise<Uint8Array>;
  restore(data: Uint8Array): Promise<void>;
}

export interface EmbeddingCapable {
  embed(text: string): Promise<number[]>;
}

export interface KnowledgeGraphCapable {
  queryEntities(name: string): Promise<Entity[]>;
  queryRelations(from: string, relation?: string): Promise<Relation[]>;
}

export interface ImportanceCapable {
  scoreImportance(input: MemoryInput): Promise<ImportanceScore>;
}

export interface ReconsolidationCapable {
  findContradictions(factId: string): Promise<Contradiction[]>;
}

export interface TemporalCapable {
  applyDecay(): Promise<void>;
  recallWithHistory(query: string, at?: number): Promise<MemoryHit[]>;
}

export interface SessionRecallCapable {
  sessionRecall(text: string, opts?: { topK?: number }): Promise<string | null>;
}
```

### alpha-memory capability coverage

| Capability | Alpha supports? | Source |
|---|:---:|---|
| `BackupCapable` | ✓ | existing `BackupCapable` type in alpha-memory |
| `EmbeddingCapable` | ✓ | via injected `EmbeddingProvider` |
| `KnowledgeGraphCapable` | ✓ | `knowledge-graph.ts` module |
| `ImportanceCapable` | ✓ | `importance.ts` module |
| `ReconsolidationCapable` | ✓ | `reconsolidation.ts` (`findContradictions`) |
| `TemporalCapable` | ✓ | `decay.ts` (Ebbinghaus) + `deepRecall` |
| `SessionRecallCapable` | ✓ | `sessionRecall()` method |

Alpha-memory satisfies all 7 capabilities. Alternative implementations (`mem0`, custom, in-memory) can choose their subset; consumers (`naia-agent/runtime`) check capability before use.

## 4. Open questions (deferred to implementation)

These are **Part B** in the migration plan — decided at implementation time, not now:

- `@nextain/alpha-memory` npm version to pin
- Adapter injection pattern: wrapper class in `naia-agent/runtime`, or direct peerDep
- `EmbeddingProvider` injection — shell-owned or naia-agent-owned?
- `Episode.strength` vs. cosine similarity semantics in `MemoryHit.score`
- `ConsolidationResult` logging channel (provider's Logger? host's?)
- Failure mode: alpha-memory internal crash → `MemoryProvider.close` + rebuild? or surface `ErrorEvent`?

## 5. Acceptance (MVM #1 exit)

- [x] Alpha-memory public API surface documented
- [x] Minimum façade drafted (4 methods)
- [x] Capability coverage mapped (7 capabilities, all satisfied by alpha-memory)
- [x] Open questions logged (deferred to Part B)
- [x] Interface file `packages/types/src/memory.ts` scaffolded (completed in MVM #2)

## 6. mem0 dual audit (Phase 0 S1b)

Plan v6 Phase 0 S1 includes a dual audit "alpha-memory + mem0". This section
confirms mem0 is already accommodated by the existing design.

### mem0 is not a separate MemoryProvider

Alpha-memory has three internal adapters (`LocalAdapter`, `Mem0Adapter`,
`QdrantAdapter`) all implementing the **internal** `MemoryAdapter`
interface. `MemorySystem` — the orchestrator — is the single
`MemoryProvider` façade. The layering is:

```
MemoryProvider (public façade, @naia-agent/types)
   └── MemorySystem (alpha-memory orchestrator)
        └── MemoryAdapter (Local / Mem0 / Qdrant — backend choice)
             └── mem0 / SQLite+hnswlib / Qdrant
```

Therefore, from a naia-agent consumer's perspective, whether alpha-memory
uses mem0 as a backend or not is **transparent**. No façade change is
required.

### Source references

- `alpha-memory/src/memory/index.ts` — `MemorySystem` (the façade)
- `alpha-memory/src/memory/types.ts` — `MemoryAdapter` interface (internal)
- `alpha-memory/src/memory/adapters/mem0.ts` — `Mem0Adapter` (internal backend)

### Capability implications

All 7 `MemoryProvider` Capabilities (see §3) continue to apply regardless
of backend choice — they are implemented in alpha-memory's top layer, not
in the backend. `Mem0Adapter` can be swapped in without affecting:
`BackupCapable`, `EmbeddingCapable` (uses injected `EmbeddingProvider`),
`KnowledgeGraphCapable`, `ImportanceCapable`, `ReconsolidationCapable`,
`TemporalCapable`, `SessionRecallCapable`.

### Acceptance (S1b)

- [x] mem0 integration path identified: internal `MemoryAdapter` swap
- [x] No `MemoryProvider` façade change required
- [x] Capability coverage preserved across adapter swaps
- [x] Open question logged: mem0-specific tuning (LLM-based dedup, KO
      handling) is adapter-layer concern, not façade concern. Deferred
      to alpha-memory's own roadmap (see alpha-memory#12)

## References

- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md` v6 §A.5, Phase 0 S1/S1b
- Alpha-memory source: `nextain/alpha-memory@main` (post-bd2ad3b)
