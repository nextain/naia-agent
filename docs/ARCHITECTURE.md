# naia-agent Architecture

Status: Phase 1 (pre-v0.1). Summary-level document; the full normative
source is the migration plan at
`alpha-adk/.agents/progress/naia-4repo-migration-plan.md` (Part A).

## Philosophy — Interfaces, not dependencies

The four Naia repos (`naia-os`, `naia-agent`, `naia-adk`, `alpha-memory`)
couple only through **published interfaces**, not runtime dependencies.

- **Transparent** — every interface is specified in
  `@nextain/agent-types`, `@nextain/agent-protocol`, or
  `@naia-adk/skill-spec`. Documented, versioned, open.
- **Non-binding** — companion repos do not import the runtime. They
  implement the contracts; hosts inject concrete implementations.
- **Abstracted** — swap any LLM provider, memory backend, skill source, or
  host. Nothing else changes.

This is Ports & Adapters at ecosystem scale.

## Repo map

| Repo | Role |
|------|------|
| `naia-os` | Host — Tauri shell, 3D avatar, OS image (Bazzite) |
| **`naia-agent`** (this) | Runtime engine, LLMClient impls, observability defaults |
| `naia-adk` | Workspace format + skills library (`@naia-adk/skill-spec`) |
| `alpha-memory` | Reference `MemoryProvider` implementation |

## Package map (naia-agent)

```
@nextain/agent-types       — contracts (zero-runtime-dep)
@nextain/agent-protocol    — wire protocol (zero-runtime-dep)
@nextain/agent-core        — runtime loop + dispatch (WIP)
@nextain/agent-runtime     — tool exec + skill loader (future)
@nextain/agent-providers   — LLMClient impls (AnthropicClient today)
@nextain/agent-messengers  — channel adapters (future — Discord/TG)
@nextain/agent-observability — default Logger/Tracer/Meter impls
@nextain/agent-cli         — bin entry (future)
@nextain/agent-tts         — TTS package (Phase 2 X7)
@nextain/agent-testing     — test fixtures (future)
```

Published contracts live in three packages:

| Package | Contents |
|---------|----------|
| `@nextain/agent-types` | LLMClient, MemoryProvider, Event, ErrorEvent, VoiceEvent, TierLevel, ToolExecutor, ApprovalBroker, HostContext, Logger/Tracer/Meter — everything a consumer needs |
| `@nextain/agent-protocol` | StdioFrame + encode/parse. Separate so wire breaks don't force types MAJOR. |
| `@naia-adk/skill-spec` | SkillDescriptor, SkillLoader, SkillManifest. Lives in the naia-adk repo because skills are workspace-format concerns, not runtime concerns. |

## Dependency graph (no cycles)

```
types, protocol, skill-spec   ← zero-runtime-dep, no cross-deps at runtime
      ▲       ▲       ▲
      │       │       │
     (type-only imports allowed between contract packages)
      │       │       │
core, runtime, providers, messengers, observability   ← impl packages
      ▲
      │ embeds
      │
   naia-os shell / CLI host
```

Rules:

- Contract packages (`types`, `protocol`, `skill-spec`) are zero-runtime-dep.
- Impl packages freely import contract packages.
- Contract packages **never** import impl packages.
- `@naia-adk/skill-spec` defines its own `SkillTier` (identical values to
  `@nextain/agent-types`'s `TierLevel`) instead of importing — keeps
  skill-spec tool-agnostic for claude-code/opencode/codex consumers.

## Runtime layers

```
[L1] Host               naia-os / CLI / server
                        Process, I/O, dependency injection               ↑ embeds
───────────────────────────────────────────────────────────────────────
[L2] Agent (this repo)  naia-agent
                        Loop · tools · compaction · hot memory           ↓ calls
───────────────────────────────────────────────────────────────────────
[L3] LLM Client         LLMClient interface (+ adapters)
                        Concrete: Gateway / Direct / Mock                ↓ HTTP
───────────────────────────────────────────────────────────────────────
[L4] Routing Gateway    any-llm or equivalent
                        Provider selection · fallback · auth             ↓
───────────────────────────────────────────────────────────────────────
[L5] Providers          Anthropic / OpenAI / Google / local models
```

The agent depends only on the injected `LLMClient` interface. It has no
knowledge of which provider, gateway, or network protocol carries the call.

## Contract summary

See each package's source + README for normative definitions. Short list:

**`LLMClient`** — `generate(req) → Response` and `stream(req) → AsyncIterable<Chunk>`. Covers streaming, tool-calls, prompt cache. [llm.ts](../packages/types/src/llm.ts)

**`MemoryProvider`** — `encode / recall / consolidate / close` + 7 optional Capabilities (Backup, Embedding, KnowledgeGraph, Importance, Reconsolidation, Temporal, SessionRecall). [memory.ts](../packages/types/src/memory.ts)

**`ToolExecutor`** — `execute(invocation, signal) → result`. Tier-gated. [tool.ts](../packages/types/src/tool.ts)

**`ApprovalBroker`** — `decide(request) → decision`. Shell owns UI, runtime owns state. [approval.ts](../packages/types/src/approval.ts)

**`HostContext`** — dependency-injection surface (llm, memory, tools, approvals, identity, logger, tracer, meter). Minimal subset `HostContextCore` available. [host.ts](../packages/types/src/host.ts)

**`Event` / `ErrorEvent` / `VoiceEvent`** — observability backbone. Every implementation MUST emit at major state transitions. `ErrorEvent.severity` is distinct from `TierLevel` (naming collision avoided). [event.ts](../packages/types/src/event.ts) · [voice.ts](../packages/types/src/voice.ts)

**`Logger` / `Tracer` / `Meter`** — observability contracts. Default impls in `@nextain/agent-observability`: ConsoleLogger, NoopTracer, InMemoryMeter. [observability.ts](../packages/types/src/observability.ts)

## Versioning (plan A.8)

Each package is independent semver. No shared version train.

- `@nextain/agent-types` — MAJOR = shape break, MINOR = additive, PATCH = internal
- `@nextain/agent-protocol` — independent; wire break ≠ types break
- `@naia-adk/skill-spec` — independent; not lockstep with naia-adk tag
- Impl packages — free to move ahead of contracts

Breaking changes require 4-week advance notice post-v0.1 (plan A.11
communication policy). Pre-v0.1 (now) — expect frequent breaking.

## Security boundaries (plan A.6 / A.11)

| Concern | Owner |
|---------|-------|
| Device identity (Ed25519) | shell stronghold → injected via `HostContext.identity` |
| LLM API keys | shell stronghold → injected into `LLMClient` at host construction |
| Discord bot token, OAuth | shell stronghold → messengers on init |
| Tier T0-T3 approval UI | shell |
| Tier enforcement | `runtime.ToolExecutor` |
| Credits dashboard | shell |
| Credits usage emission | providers (via `HostContext.meter`) |
| Audit log | shell (tamper-evident, minimum retention) |
| OS-level integration, packaging | shell |

## Status tracker

| Phase 1 | Status |
|---------|:---:|
| T1 `@nextain/agent-types` initial shape | ✓ (v0.0.1) |
| T2 `@nextain/agent-protocol` package | ✓ (v0.0.1) |
| T3 `@naia-adk/skill-spec` package | ✓ (v0.0.1, in naia-adk repo) |
| T4 `@nextain/agent-observability` defaults | ✓ (v0.0.1) |
| T5 `HostContext` + `VoiceEvent` + all contracts | ✓ |
| T6 `MemoryProvider` façade | ✓ (alpha-memory audit + mem0 dual audit done) |
| T7 `docs/ARCHITECTURE.md` (this file) | ✓ |
| T8 v0.1.0 freeze — additive-only rule active | ✓ (see [CHANGELOG.md](../CHANGELOG.md)) |

## Pointers

- Migration plan (full normative): `alpha-adk/.agents/progress/naia-4repo-migration-plan.md`
- Memory façade audit: `docs/memory-provider-audit.md`
- Voice pipeline audit: `docs/voice-pipeline-audit.md`
- README (top level): `../README.md`
