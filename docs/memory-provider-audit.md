# MemoryProvider Audit — naia-memory mapping

> **Languages**: English (this file) · [한국어](../.users/docs/ko/memory-provider-audit.md)

**Status**: refreshed 2026-05-20 to reflect the CLI memory shipped surface
(Slice 3-XR-C-mem, 3-XR-D recall-residue hygiene, 3-XR-F/G/I cross-process
verification).
**Source**: `nextain/naia-memory` (live). Exports inspected from
`src/memory/index.ts`, `src/memory/types.ts`, `src/memory/lite-provider.ts`,
and `src/memory/adapters/`.
**Goal**: document the shipped façade + bindings + capability coverage,
and the remaining roadmap items.

## 1. Shipped vs Roadmap (2026-05-20)

### Shipped

- **`LiteMemoryProvider`** — SQLite + injected embedder, reference
  `MemoryProvider` implementation (Slice 3-XR-C-mem, 2026-05-15). Used by
  the CLI in `--memory` mode; backed by `better-sqlite3` (now correctly
  built — `package.json` `pnpm.onlyBuiltDependencies` includes
  `better-sqlite3` and `esbuild`).
- **`--memory` CLI flag** — `pnpm naia-agent --memory "…"` opens a
  persistent `LiteMemoryProvider` at `NAIA_AGENT_MEMORY_DB` (default
  under the per-user naia-agent config root). Any failure degrades
  gracefully to ephemeral `InMemoryMemory` — the CLI never crashes over
  memory (anchor #6).
- **`OpenAICompatEmbeddingProvider` wiring** — `--memory` builds the
  embedder from `NAIA_EMBED_*`. The CLI normalises the embed base URL
  (strips a trailing `/v1`) so a uniform `…/v1` naia-settings baseUrl
  does not produce `…/v1/v1/embeddings` (root-cause fix; previously
  every encode failed silently).
- **`<recall>` marker protocol + `MEMORY_PERSONA`** — strict parser in
  the core; `--memory` without an explicit `--system` installs the
  built-in recall-protocol persona so the marker actually fires. The
  persona is language-neutral (general-purpose, no Korean directive).
- **`stripRecallResidue` sanitiser (Slice 3-XR-F)** — exported pure
  function; the agent strip-path uses it. The STRICT match/act is
  unchanged (leniency never reaches recall behaviour). Anchored to the
  `recal` family only; preserves quoted protocol docs and code; returns
  marker-free input byte-identical.
- **Cross-process recall verified LIVE** — Group A3 (24G live, Korean)
  and Group F2 (persona + memory composition) in
  `packages/cli-app/src/__tests__/integration-scenarios.test.ts` exercise
  store-in-process-A / recall-in-process-B against the shared
  `LiteMemoryProvider` SQLite. The same invariant is mirrored by the
  USER S8 / S8-neg pair in `bin-user-scenarios.test.ts` — both confirmed
  on R4 + R5 (2-consecutive PASS).
- **Service-mode binding** — service manifests with `memory.binding:
  "alpha-memory"` resolve via `resolveMemoryBinding`, which lazily loads
  naia-memory and refuses any db path outside the per-service `services/`
  directory (sandbox).

### Roadmap

- **Supervisor-mode auto-injection** of `recall → extraSystemPrompt` —
  today the CLI persona instructs the model to emit `<recall>` markers;
  the supervisor mode (host-driven orchestration) should pre-inject the
  recall text into a turn-local system prompt slice before the model
  sees the user message.
- **Encode / decay cadence tuning** — `MemorySystem` consolidation +
  Ebbinghaus decay run on built-in schedules; expose hooks so hosts can
  pace them against session activity.
- **`naia-adk` `getMemoryStoragePath()` helper** — a single SoT for "where
  does memory live for this naia-adk path", consumed by the CLI and any
  future host so the path policy is not duplicated across consumers.

## 2. Current naia-memory surface

### Top-level: `MemorySystem` (orchestrator)

Public methods relevant to the façade:

| Method | Signature | Role |
|---|---|---|
| `encode` | `(input: MemoryInput, context?: EncodingContext) → Promise<Episode \| null>` | Importance-gated storage into episodic store |
| `recall` | `(query: string, context?: RecallContext) → Promise<Episode[]>` | Context-dependent retrieval with decay weighting |
| `consolidate` | `() → Promise<ConsolidationResult>` | Episodic → semantic via fact extraction |
| `sessionRecall` | `(text: string, opts?: { topK? }) → Promise<string \| null>` | Formatted context block for LLM injection |
| `close` | `() → Promise<void>` | Cleanup resources |
| `startConsolidation` | `() → void` | Background consolidation loop |

### `LiteMemoryProvider` (shipped reference implementation)

`LiteMemoryProvider` is the SQLite-backed reference implementation of
`MemoryProvider`. It owns its own connection, accepts an injected
embedder, and is the implementation the CLI uses by default in `--memory`
mode. Sized for personal-assistant footprints.

### `MemoryAdapter` (lower abstraction, pluggable backend)

Interface signatures (`src/memory/types.ts`):

- `addEpisode`, `addFact`, `addSkill`, `addReflection`
- `searchEpisodes`, `searchFacts`, `searchSkills`
- `getEpisodesByIds`, update, delete variants
- `close`

### Supporting types

- `MemoryInput` — `{ content, role, context?, timestamp? }`
- `Episode` — `id, content, summary, timestamp, importance, encodingContext, consolidated, recallCount, lastAccessed, strength`
- `Fact`, `Skill`, `Reflection`
- `RecallContext` — `project, activeFile, topK, minStrength, deepRecall`
- `ImportanceScore` — `importance × surprise × emotion → utility`
- `BackupCapable` — capability interface already provided by naia-memory

### Existing adapters

- `LocalAdapter` — SQLite + hnswlib
- `QdrantAdapter` — remote vector DB
- `Mem0Adapter` — mem0 backend (internal swap, see §5)

### Embedding abstraction

- `EmbeddingProvider` interface
- Implementations: `OfflineEmbeddingProvider`, `OpenAICompatEmbeddingProvider`, `NaiaGatewayEmbeddingProvider`

## 3. `MemoryProvider` façade (for `@nextain/agent-types`)

Minimum surface — matches the A.5 contract (`encode`, `recall`,
`consolidate`, `close`) with naia-memory mapping:

```typescript
// @nextain/agent-types (zero runtime deps)

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
  deepRecall?: boolean;          // capability-gated — gracefully ignored by impls that lack it
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

### Mapping to naia-memory

| Façade method | naia-memory call | Notes |
|---|---|---|
| `encode(input)` | `memorySystem.encode(input, input.context)` | Importance gating happens inside naia-memory |
| `recall(query, opts)` | `memorySystem.recall(query, opts)` → map `Episode[]` → `MemoryHit[]` | `Episode.strength` → `MemoryHit.score` |
| `consolidate()` | `memorySystem.consolidate()` | Drop `ConsolidationResult` to `void`; caller inspects logs |
| `close()` | `memorySystem.close()` | Direct pass-through |

## 4. Optional Capability interfaces (A.5)

naia-memory features that belong in optional capabilities, not the
minimum façade:

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

### naia-memory capability coverage

| Capability | naia-memory supports? | Source |
|---|:---:|---|
| `BackupCapable` | ✓ | existing `BackupCapable` type |
| `EmbeddingCapable` | ✓ | via injected `EmbeddingProvider` |
| `KnowledgeGraphCapable` | ✓ | `knowledge-graph.ts` |
| `ImportanceCapable` | ✓ | `importance.ts` |
| `ReconsolidationCapable` | ✓ | `reconsolidation.ts` (`findContradictions`) |
| `TemporalCapable` | ✓ | `decay.ts` (Ebbinghaus) + `deepRecall` |
| `SessionRecallCapable` | ✓ | `sessionRecall()` method |

naia-memory satisfies all 7 capabilities. Alternative implementations
(`mem0`, custom, in-memory) can choose their subset; consumers
(`naia-agent/runtime`) check capability before use.

## 5. mem0 dual audit

mem0 is **not** a separate `MemoryProvider`. naia-memory has three
internal adapters (`LocalAdapter`, `Mem0Adapter`, `QdrantAdapter`) all
implementing the **internal** `MemoryAdapter` interface. `MemorySystem`
— the orchestrator — is the single `MemoryProvider` façade. The layering
is:

```
MemoryProvider (public façade, @nextain/agent-types)
   └── MemorySystem (naia-memory orchestrator)
        └── MemoryAdapter (Local / Mem0 / Qdrant — backend choice)
             └── mem0 / SQLite+hnswlib / Qdrant
```

From a naia-agent consumer's perspective, whether naia-memory uses mem0
as a backend or not is **transparent**. No façade change is required,
and all 7 capabilities continue to apply regardless of backend choice —
they are implemented in naia-memory's top layer, not in the backend.

## 6. Open questions (deferred to implementation)

- adapter injection pattern: wrapper class in `naia-agent/runtime`, or
  direct peerDep
- `EmbeddingProvider` injection — shell-owned or naia-agent-owned in
  full host scenarios (CLI is naia-agent-owned today)
- `Episode.strength` vs cosine similarity semantics in `MemoryHit.score`
- `ConsolidationResult` logging channel (provider's Logger? host's?)
- Failure mode beyond CLI: surface `ErrorEvent` or close + rebuild?
- mem0-specific tuning (LLM-based dedup, KO handling) — adapter-layer
  concern, not façade concern

## 7. References

- `CHANGELOG.md` — Slice 3-XR-C-mem (memory wired into CLI),
  Slice 3-XR-D (recall-residue hygiene), Slice 3-XR-F (`stripRecallResidue`
  + USER S8 cross-process invariant), Slice 3-XR-G/I (Groups A3 + F2
  live recall verification).
- `bin/naia-agent.ts` — `--memory` wiring, `MEMORY_PERSONA`,
  `buildCliMemory`, `resolveMemoryBinding("alpha-memory")`.
- `packages/cli-app/src/__tests__/integration-scenarios.test.ts`
  Groups A3 / F2.
- `packages/cli-app/src/__tests__/bin-user-scenarios.test.ts` S8 / S8-neg.
- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md`
  §A.5, Phase 0 S1 / S1b.
- naia-memory source: `nextain/naia-memory` main.
