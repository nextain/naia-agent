# @nextain/agent-types

> **Languages**: English (this file) · [한국어](../../.users/docs/ko/packages/types/README.md)

Zero-runtime-dep public contracts for the Naia ecosystem.

**ESM-only, Node ≥ 22.** Requires TypeScript 5.0+.

This package contains only types — no runtime code. It is safe to depend on
from any consumer without pulling LLM SDKs, filesystem libraries, or other
runtime dependencies.

## Contents

Re-exported from `src/index.ts` (every export is a type or const type alias —
no runtime values):

- **LLM contracts** (`llm.ts`) — `LLMClient`, `LLMRequest`, `LLMResponse`,
  `LLMMessage`, `LLMRole`, `LLMContentBlock`, `LLMContentDelta`,
  `LLMStreamChunk`, `LLMUsage`, `LLMImageSource`, `ToolDefinition`,
  `PromptCacheHint`, `StopReason`.
- **Memory provider** (`memory.ts`) — `MemoryProvider` base contract
  (`encode` / `recall` / `consolidate` / `close`) plus optional Capability
  interfaces (`BackupCapable`, `EmbeddingCapable`, `KnowledgeGraphCapable`,
  `ImportanceCapable`, `ReconsolidationCapable`, `TemporalCapable`,
  `ContradictionFilterCapable`, `SessionRecallCapable`, `CompactableCapable`)
  and the `isCapable()` structural guard.
- **Events** (`event.ts`) — `Event`, `ErrorEvent`, `Severity`.
- **Voice / observability / session / approval / host** — `voice.ts`,
  `observability.ts` (`Logger`, `Tracer`, `Meter`), `session.ts`, `approval.ts`
  (`ApprovalBroker`), `host.ts` (`HostContext`, `HostContextCore`,
  `DeviceIdentity`).
- **Tool execution** (`tool.ts`) — `ToolExecutor`, `ToolInvocation`,
  `ToolExecutionResult`, `ToolExecutionContext`, `ToolDefinitionWithTier`,
  `TierLevel`, `TierPolicy`.
- **Hybrid Wrapper additions (R4, 2026-04-26)** — `stream.ts`
  (`NaiaStreamChunk` unified multi-modal stream), `sub-agent.ts`,
  `verification.ts`, `workspace.ts`.
- **Background / Active brain (R4 #26)** — `spike.ts`.

### Slice 3-XR shipping notes

The Slice 3-XR series consolidated several additive shapes (all
backward-compatible — no new union arms in existing discriminated unions,
optional fields only):

- **`MemoryProvider` extensions** — R2.5 alignment with naia-memory:
  `RecallOpts` gained `project` / `sessionId`; `MemoryHit` gained
  `createdAt` / `updatedAt`; `ConsolidationSummary` gained `factsUpdated` /
  `episodesProcessed`; `EncodeOpts` introduced; `BackupCapable` requires a
  password (AES-256-GCM scheme); `ReconsolidationCapable.findContradictions`
  takes new content + optional existing IDs; `TemporalCapable.applyDecay`
  returns the prune count; `recallWithHistory` requires `atTimestamp` and
  accepts the full `RecallOpts` shape.
- **Tool definition shape** — `ToolDefinitionWithTier` (D10) added
  `isConcurrencySafe`, `isDestructive`, `searchHint`, `contextSchema`;
  `ToolExecutionContext` (D11) added `tier` and `env` for sub-agent
  supervisor gates.
- **Stream chunk types** — `LLMStreamChunk` (Anthropic SSE shape — start /
  content_block_start / content_block_delta\* / content_block_stop / usage /
  end) plus the broader `NaiaStreamChunk` union that adds multi-modal deltas
  (`audio_delta`, `image_delta`), sub-agent lifecycle
  (`session_start` / `session_progress` / `session_end` /
  `session_aggregated`), workspace visibility (`workspace_change`),
  verification (`verification_start` / `verification_result`), honest report
  (`report`), and adversarial review (`review_request` / `review_finding`).
- **Manifest / host wiring** — `HostContext` / `HostContextCore` split for
  light vs production hosts; `DeviceIdentity` signs with a host-held Ed25519
  key. The CLI `bin/naia-agent.ts` reads provider + memory configuration
  from environment / naia-adk manifest and assembles `HostContext` at
  startup — see `@nextain/agent-providers` for the LLM side.

## Usage

```typescript
import type { LLMClient, MemoryProvider, Event } from "@nextain/agent-types";

function makeAgent(llm: LLMClient, memory: MemoryProvider) {
  // ... implementation code lives elsewhere; this package defines shapes only.
}
```

## Part of the Naia 4-repo ecosystem

- [naia-agent](https://github.com/nextain/naia-agent) — runtime engine (this repo)
- [naia-os](https://github.com/nextain/naia-os) — Tauri desktop shell
- [naia-adk](https://github.com/nextain/naia-adk) — workspace format + skill library
- [naia-memory](https://github.com/nextain/naia-memory) — reference `MemoryProvider` implementation

## License

Apache 2.0.
