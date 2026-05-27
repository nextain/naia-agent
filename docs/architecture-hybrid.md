# Architecture (Hybrid Wrapper, R4 lock 2026-04-26)

> **Languages**: English (this file) · [한국어](../.users/docs/ko/architecture-hybrid.md)

> **Parent**: `docs/vision-statement.md` (R4 lock)
> **Previous**: `docs/ARCHITECTURE.md` (R0~R3, canonical SoT preserved; R4 is additive)
> **status**: design lock (Week 0)

---

## 1. layer overview

```
┌────────────────────────────────────────────────────────────────────┐
│ [user]  voice / text / keypress (interrupt included)               │
└─────┬──────────────────────────────────────────────────────────────┘
      │
┌─────▼────────── naia-shell (separate repo, Phase 4+) ──────────────┐
│  • voice (STT/TTS)                                                 │
│  • avatar (VRM, lip-sync)                                          │
│  • unified UI (main chat + sub-session cards + workspace diff)     │
└─────┬──────────────────────────────────────────────────────────────┘
      │ stdio / IPC (Phase 1~3 = direct CLI usage allowed)
      ▼
┌─────────────── naia-agent (this repo) ─────────────────────────────┐
│                                                                    │
│  apps/cli/repl                  ← Alpha chat window (Phase 1)      │
│       │                                                            │
│  ┌────▼─────────────────────────────────────────────────────────┐ │
│  │ core (thin)                                                   │ │
│  │   conversation  supervisor  interrupt  stream-merger          │ │
│  └────┬─────────────────┬─────────────────┬─────────────────────┘ │
│       │                 │                 │                        │
│  ┌────▼────────┐  ┌────▼────────┐  ┌────▼────────────────────┐  │
│  │ adapters/   │  │ workspace/  │  │ verification/             │  │
│  │ opencode    │  │ watcher     │  │ orchestrator              │  │
│  │ claude-code │  │ diff        │  │ runners {test/lint/build} │  │
│  │ shell       │  │             │  │ reporter                  │  │
│  └────┬────────┘  └────┬────────┘  └────┬─────────────────────┘  │
│       │                │                 │                        │
│  ┌────▼────────┐  ┌────▼────────┐  ┌────▼────────┐                │
│  │ providers/  │  │ memory/     │  │ observability│                │
│  │ openai-     │  │ naia-memory │  │ logger/dev/  │                │
│  │ compat      │  │ adapter     │  │ redact       │                │
│  └────┬────────┘  └────┬────────┘  └─────────────┘                │
└───────┼────────────────┼───────────────────────────────────────────┘
        │                │
   ┌────▼──────┐    ┌────▼──────────────────┐
   │ any-llm   │    │ naia-memory (peer)    │
   │ (gateway) │    │ naia-adk (peer)       │
   └───────────┘    └───────────────────────┘
   (Voice = naia-os + naia-omni territory — naia-agent is LLM text turn only)
        ▲
        │ HTTP OpenAI-compat
   external LLM (Anthropic / Google / GLM / OpenAI / OpenRouter ...)
```

**Dependency direction**: unidirectional (top → bottom). naia-agent does not know sub-agent internals (interface-only).

---

## 2. package map (R4 additions/moves)

| location | up to R3 | R4 change |
|---|---|---|
| `packages/types/` | LLM/Tool/Memory/Skill/Observability interfaces | + `SubAgentAdapter` `Verifier` `WorkspaceWatcher` `NaiaStreamChunk` (D20/D24) |
| `packages/core/` | `Agent` (turn loop) | + `Supervisor` `Conversation` `Interrupt` `StreamMerger` |
| `packages/runtime/skills/{bash,file-ops}` | bash/file-ops skill bodies | **demoted to dev-only** (Phase 1 fallback) — production delegates to opencode/cc |
| `packages/providers/anthropic.ts` | direct Anthropic SDK | **demoted to dev-only** — production goes through any-llm |
| `packages/providers/openai-compat.ts` | OpenAI-compat fetch | **kept** (main any-llm call path) |
| `packages/providers/anthropic-vertex.ts` | Vertex SDK | **candidate for removal** — any-llm handles Vertex routing |
| `packages/observability/` | Logger / dev-logger / redact | **kept** (Logger.fn() trace standard scope expands) |
| **`packages/adapters/`** (new) | — | opencode / claude-code / shell adapter |
| **`packages/workspace/`** (new) | — | watcher (chokidar) + diff (git diff) |
| **`packages/verification/`** (new) | — | orchestrator + runners + reporter |
| **`packages/memory/`** (new) | — | naia-memory adapter |
| **`apps/cli/`** (new) | bin/naia-agent.ts (already in R3) | extracted + uses Conversation/Supervisor |

---

## 3. seven design principles

| # | principle | enforcement |
|---|---|---|
| 1 | **Layered architecture** — unidirectional dependencies (top → bottom only) | tsconfig project references + lint rule |
| 2 | **Interface-first** — interfaces in `@nextain/agent-types`, implementations in separate pkgs. Host injects. | F03 variant enforcement |
| 3 | **Stream-first** — every layer is `AsyncIterable<NaiaStreamChunk>`. No blocking. | code review |
| 4 | **No global state** — zero singletons/global variables. All state injected via ctor. | lint rule (no-mutable-export) |
| 5 | **Adapter pattern** — opencode/claude-code (and future adapters) all use the same interface. A new sub-agent = one adapter. | adapter contract test |
| 6 | **Module ≤ 300 LOC** — single-responsibility | code review |
| 7 | **Logger.fn() trace standard** — enter/branch/exit on every function | dev mode auto-check (introduced in Slice 2.7) |

---

## 4. core interfaces (skeleton of the skeleton)

Full spec lives in `docs/adapter-contract.md`. Here are just the five essentials:

```typescript
// types/src/sub-agent.ts
interface SubAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly Capability[];
  spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession>;
}

interface SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  events(): AsyncIterable<SubAgentEvent>;
  cancel(reason?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): SubAgentStatus;
}

// types/src/verification.ts
interface Verifier {
  readonly id: string;
  run(workdir: string, signal: AbortSignal): Promise<VerificationResult>;
}

// types/src/workspace.ts
interface WorkspaceWatcher {
  start(workdir: string): AsyncIterable<WorkspaceChange>;
  stop(): Promise<void>;
}

// types/src/stream.ts
type NaiaStreamChunk = { ... }  // details in stream-protocol.md
```

---

## 5. dependency direction (unidirectional, lint-enforced)

### 5a. inter-package dependencies (top-level)

```
apps/cli  →  core  →  {adapters, workspace, verification, memory, providers, observability}  →  types
                                                                                                   ↑
                                                                                          (anyone can import types)
```

**forbidden** (lint rule):
- `core` → `apps/cli` (reverse direction)
- `types` → other pkgs (types is a leaf)
- `adapters/X` → `adapters/Y` (cross-adapter direct dependency)
- `providers` ↔ `adapters` (mutually unknown)

**exceptions**:
- `observability` may be imported from any pkg (cross-cutting logger)
- `tests/` may import any pkg (test fixtures)

### 5b. core internal module DAG (P0-9 fix, Architect recommendation)

`core/` consists of 4 modules — an explicit unidirectional DAG:

```
                  ┌─────────────────────┐
                  │  core/conversation  │  (LLM call + history + decompose)
                  │  depends: types,    │
                  │           providers │
                  └──────────┬──────────┘
                             │ uses
                  ┌──────────▼──────────┐
                  │  core/supervisor    │  (sub-agent orchestration)
                  │  depends: types,    │
                  │   conversation,     │
                  │   adapters (DI),    │
                  │   stream-merger,    │
                  │   interrupt,        │
                  │   verification (DI),│
                  │   workspace (DI),   │
                  │   memory (DI)       │
                  └──────────┬──────────┘
                             │ owns
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌─────────────┐  ┌──────────┐  ┌──────────────┐
      │stream-merger│  │interrupt │  │ (event emit) │
      │ depends:    │  │ depends: │  │              │
      │  types only │  │  types   │  │              │
      └─────────────┘  └──────────┘  └──────────────┘
```

**rules**:
- `conversation` → `types` + `providers` (needs LLMClient interface to call the LLM)
- `supervisor` → everything (via DI). Its own logic is orchestration only.
- `stream-merger` → `types` only (pure function, N streams → 1 stream merge)
- `interrupt` → `types` only (pure signal management)

**lint rule**: tsconfig project references enforced, eslint `import/no-restricted-paths` policy (each module only allowed its declared imports).

**example — supervisor.ts**:
```typescript
import { Conversation } from "./conversation.js";        // OK (core internal)
import { mergeStreams } from "./stream-merger.js";        // OK
import { Interrupt } from "./interrupt.js";               // OK
import type { SubAgentAdapter } from "@nextain/agent-types"; // OK (types)
// import { OpenCodeAdapter } from "@nextain/agent-adapter-opencode"; // ✗ — direct adapter import forbidden; use DI
```

---

## 6. performance + stability design

### 6a. performance (baseline)

| area | strategy | rationale |
|---|---|---|
| Sub-agent stream | async iterable (back-pressure naturally supported) | matrix D01 stream-first |
| File watcher | chokidar debounce 100ms — multiple changes to the same file collapse into 1 chunk (latest state) | matrix D27 + Architect P1-1 |
| Diff compute | lazy (git diff called only on user request) | avoids overhead on large repos |
| LLM cache | leverage any-llm / Anthropic `cache_read` | matrix D16 prompt cache |
| Multi-stream merge | `Promise.race` round-robin (non-blocking) | block-free |
| Verification | parallel (test/lint/build concurrently) | shorter wall time |
| Logger | dev-only file logging (zero production overhead) | Slice 2.7 dev-mode auto |
| ACP/SDK call | timeout + cancel signal always set | prevent unbounded hangs |

### 6b. verification triple defense (P0-10, matrix D27)

The verification orchestrator is fail-safe through three layers:

| layer | mechanism | trigger |
|---|---|---|
| **L1: abort signal** | every verifier checks `VerifierContext.signal`. On abort it stops immediately. | user cancel / parent timeout |
| **L2: memory limit** | child process spawn applies `--max-old-space-size` or cgroup memory limit. OOM-kill on overrun. | runaway test/lint |
| **L3: wall-clock timeout** | per-runner default timeout (Phase 1 = 60s, Phase 2+ = 5min override allowed) | hang / infinite loop |

Any one of the three triggering → emit `verification_result(pass: false, ...)` + `session_end(reason: "timeout")`.

**rationale**: avoids the cleanroom F11 silent-drop pattern + matches Mastra D13.

### 6c. interrupt deadline (P0-7, Paranoid)

Voice "stop stop" → STT → naia-agent supervisor → adapter cancel:

| step | budget |
|---|---|
| mic capture | 50ms |
| STT (Whisper minimal) | ≤ 800ms (keyword detection + partial decode) |
| naia-agent core dispatch | ≤ 50ms |
| **adapter.cancel() invocation** | ≤ 50ms |
| **adapter session_end emit** | ≤ 500ms (hard deadline) |
| **total voice → child kill** | **≤ 1.5 s** |

**hard kill enforcement**:
- if adapter.cancel() does not emit session_end within 500ms → supervisor sends SIGKILL (Node.js `subprocess.kill('SIGKILL')`)
- verified by contract test C12 (`adapter-contract.md`)

**T2/T3 tool pre-gating** (race protection):
- destructive tools (rm, git push, chmod, …) = T2/T3 → ApprovalBroker pre-approval enforced
- cannot execute before user approval → no destructive action possible during the "stop" latency window

→ "stop" voice command → child process terminated within 1.5 s, guaranteed. During that window, destructive actions are blocked by the approval gate.

---

## 7. maintainability design

| change scenario | scope of impact | regression risk |
|---|---|:---:|
| opencode v1 → v2 (breaking) | only `adapters/opencode/` | low |
| new sub-agent (e.g. aider) | new `adapters/aider/` | none |
| add an LLM provider | `providers/` only | none |
| add a verification runner | `verification/runners/` only | none |
| add a stream chunk type | `types/stream.ts` + presentation layer | medium (every consumer must handle the union) |
| introduce naia-shell | add `apps/shell` alongside — core untouched | none |
| any-llm endpoint change | env config | none |

---

## 8. test pyramid

| level | tooling | target |
|---|---|---|
| **unit** (mock) | vitest + all deps mocked | each module's logic in isolation |
| **adapter contract** | vitest + fake ACP/SDK server | adapter spec compliance |
| **integration** (fixture) | vitest + StreamPlayer (G15) | sub-agent event sequence replay |
| **integration** (real) | vitest opt-in (needs KEY) | one real opencode/any-llm turn |
| **E2E** | shell script + naia-agent CLI | "add hello function" → result verification |

CI: unit + adapter contract + integration fixture only (no KEY). real-LLM is opt-in.

---

## 9. security design (4-repo plan A.6 preserved + Hybrid additions)

| concern | location | R4 addition |
|---|---|---|
| LLM API key | shell stronghold (HostContext.llm injection) | one any-llm key per naia account |
| Tier policy (T0~T3) | runtime (`GatedToolExecutor`) | sub-agent also subject to tier (ACP approval) |
| Approval UI | shell (`ApprovalBroker.decide()`) | also available on sub-session cards |
| Audit log | shell (tamper-evident, 30+ days) | sub-agent events included in the trail |
| Bash dangerous-command block | runtime (DANGEROUS_COMMANDS regex) | extra layer on top of opencode/cc native security (optional) |
| Path traversal | runtime (path normalization) | sub-agent workdir isolated (enforced in `spawn` ctx) |
| Sub-agent containment | adapter ctor declares workdir / env | escape prevention (`adapters/*` spec) |
| Interrupt priority | core/interrupt | SIGTERM allowed even during T2/T3 tool execution |

---

## 10. amendment procedure after R4 lock

To change this architecture:
1. Add a Change log section in this file
2. Add rationale in r4-hybrid-wrapper-2026-04-26.md
3. New entry in matrix §D, or new rejection in §B
4. Comment on master issue #2
5. Proceed after cross-review (3-perspective)

§A adoptions are R0-locked and stay unchanged in R4 as well.
