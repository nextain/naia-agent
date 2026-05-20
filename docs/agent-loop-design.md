# Agent Loop Design — references and decisions

> **Languages**: English (this file) · [한국어](../.users/docs/ko/agent-loop-design.md)

Design doc for `packages/core/src/agent.ts` (Phase 2 X3 scaffold).
Captures why each choice was made, with reference to source material.

> **F06 immutability**: decisions D1~D8 below are immutable. New decisions
> are appended at the bottom under "Appended D decisions (Slice 3-XR
> series)" as Dn matrix rows — never inlined into D1~D8.

## References surveyed

| Source | Location | Strength | Weakness |
|---|---|---|---|
| **careti** (via naia-os/agent) | `naia-os/agent/src/index.ts` | Battle-tested streaming, `MAX_TOOL_ITERATIONS` loop, tool partitioning (concurrent vs sequential), tier-based approval via `pendingApprovals` Map, token budget pre-flight (warn-only), MCP cleanup | Budget check warns but does not compact — compaction TODO'd to #185 Phase 2 |
| **opencode session/compaction** | `refs/ref-opencode/packages/opencode/src/session/{session,compaction,processor}.ts` | Formal compaction policy: `PRUNE_MINIMUM`, `PRUNE_PROTECT`, `preserveRecent`, turn-unit granularity. DB-backed persistence. | Effect + SQL makes it heavy for an embeddable runtime library. Overkill for our zero-runtime-dep + DI-first posture. |
| **claude-code** (analysis) | `.agents/progress/11-ref-cc-analysis.json` + naia-os README quote | Automatic compaction, `CLAUDE.md`-based memory layer with subagent spawning | Memory is file-system and single-directional — no bidirectional real-time memory update |
| **alpha-memory** | `projects/alpha-memory/src/memory/index.ts` | 4-store architecture, background consolidation (30-min default), reconsolidation (contradiction detection), Ebbinghaus decay, `consolidateNow(force)` for manual trigger | Current `consolidate()` is background; real-time stream compaction is a future capability (discussed separately) |

## Decisions

### D1. Stream-first API, `send()` as drain wrapper

```
Agent.sendStream(userText, signal?): AsyncGenerator<AgentStreamEvent>
Agent.send(userText, signal?): Promise<string>  // drains sendStream
```

**Why**: streaming is the only shape compatible with alpha-memory's
planned real-time compaction (it wants to observe generation as it
happens). `send()` as a convenience wrapper keeps the simple case simple.

Ref: careti (stream-based) > opencode (also stream, via Effect).

### D2. Compaction delegated to MemoryProvider via `CompactableCapable`

```ts
// @nextain/agent-types/memory.ts
export interface CompactableCapable {
  compact(input: CompactionInput): Promise<CompactionResult>;
}
```

**Why**:
- **Alpha-memory integration target** — memory already owns consolidation; compaction is a natural extension.
- **Real-time future** — alpha-memory can evolve `compact()` from on-demand to pre-computed (maintain rolling summary during `encode()` calls). Agent code does not change.
- **Graceful degradation** — if `memory` does not implement the capability, Agent falls back to simple sliding-window truncation (keep tail N, drop head).

Ref: opencode formalized compaction but tied it to its own DB; we abstract
to a capability interface so any memory can plug in.

### D3. Compaction policy constants (agent-side)

| Param | Default | Why |
|---|---:|---|
| `contextBudget` | 80_000 tokens | Safe for most 128K+ context models |
| `compactionKeepTail` | 6 messages | ~3 turns; matches opencode `DEFAULT_TAIL_TURNS = 2` (bit more generous) |
| `estimateTokens` | chars/4 heuristic | Host injects provider-accurate tokenizer when available |

Triggered before every LLM call (inside the tool-hop loop), so long
tool-use chains eventually compact themselves instead of exploding.

### D4. Tool-hop loop bounded by `maxToolHops` (default 10)

**Why**: matches careti's `MAX_TOOL_ITERATIONS = 10`. Prevents
runaway loops, surfaces the condition via `turn.ended` with stub text
`[agent stopped — reached max tool-hop budget]`. Logger emits warning.

### D5. Tool execution delegated via `HostContext.tools` + `tierForTool` resolver

Agent does not implement approval, tier policy, or actual execution. It
constructs a `ToolInvocation` with tier from the caller-provided resolver
and delegates to `HostContext.tools.execute()`. Wrap with
`GatedToolExecutor` (from `@nextain/agent-runtime`) for tier-based
approval flow, or a plain executor for tests.

**Why**: matches plan A.6 — tier enforcement lives in runtime's
`ToolExecutor` impl, shell owns approval UI via `ApprovalBroker`.

Ref: careti's `needsApproval(call.name)` → `waitForApproval(...)` pattern,
but factored behind an interface rather than inlined.

### D6. Memory `encode` at turn end, `recall` at turn start

- Turn start: `recall(userText, { topK: 5 })` — injects memory hits into system prompt
- Turn end: `encode(userText, "user")` + `encode(assistantText, "assistant")`

**Why**: minimum viable bidirectional flow. Advanced hooks (mid-stream
encoding, selective tool-result encoding) are deferred to a future
iteration. The contract allows them — any memory that wants stream-level
granularity can add a sub-capability.

Note: `encode()` errors are caught and logged but do not fail the turn —
memory is non-critical to the user-visible response.

### D7. Session lifecycle owned by Agent

Agent owns a `Session` object, transitions it through `ALLOWED_TRANSITIONS`
from `@nextain/agent-types/session.ts`. Emits `session.{created,active,...}`
events via Logger. `close()` transitions to `closed` and calls
`memory.close()`.

**Why**: plan A.5 — `naia-agent/core` owns session transition logic;
storage lives elsewhere.

### D8. `AgentStreamEvent` union surfaces every observable

```ts
type AgentStreamEvent =
  | { type: "session.started"; session }
  | { type: "turn.started"; userText; recalled }
  | { type: "llm.chunk"; chunk }
  | { type: "tool.started"; invocation }
  | { type: "tool.ended"; invocation; result }
  | { type: "compaction"; droppedCount; realtime }
  | { type: "usage"; usage }
  | { type: "turn.ended"; assistantText }
  | { type: "session.ended"; state };
```

**Why**: lets hosts (TUI, web UI, logging) observe internal transitions
without bolting event listeners. `llm.chunk` forwards the raw
`LLMStreamChunk` for low-level cases (token-by-token rendering).

Ref: opencode's BusEvent is more elaborate (publish-subscribe across
services); we use a yielded union for a simpler embedded story.

## Alpha-memory integration roadmap

| Now (v0.1) | Next | Future |
|---|---|---|
| `encode`/`recall`/`consolidate`/`close` | `compact()` via `CompactableCapable` | Real-time compaction hook: memory observes LLM stream, maintains rolling summary, `compact()` returns instantly |
| Background consolidation (30 min) | On-demand `consolidateNow()` triggered by agent | Per-turn micro-consolidation (light, predictable) |
| Recall via vector search | Recall biased by current session | Attention-aware recall (what was just said) |
| — | Sub-capabilities discoverable via `isCapable()` | Capability registry auto-populated |

## Deferred / follow-up

- Real tokenizer integration (provider-accurate counts). Currently chars/4
- `sub-agent` spawning (claude-code pattern). Agent is single-level today
- MCP bridge via runtime (X4, continuation of #200)
- Prompt caching strategy — passthrough today, opinionated policy pending
- Multi-session concurrency within a host — one HostContext = one Session (plan A.12)

## Testing surface

Current: `scripts/smoke-anthropic.ts` exercises `AnthropicClient` directly
(not `Agent`). An `Agent`-level smoke (InMemoryMemory + Mock LLM + Mock
Tools) lands in a follow-up commit once bash is available to run builds.

---

## Appended D decisions (Slice 3-XR series)

These rows are additive per F06. D1~D8 above remain unchanged. Each entry
is a short prose decision + slice citation + code-evidence pointer (paths
are repo-relative).

### D-9. `safeTurn` REPL survival wrapper

Every CLI turn is wrapped in `safeTurn(agent, prompt, debug)` so a single
turn failure (model-server outage, `ECONNREFUSED`, tool error) prints an
actionable hint and **does not crash the REPL or the host process**.
Single-shot mode exits cleanly with code 2 plus the same hint; the REPL
stays alive across per-turn failures, which is what the Slice 3-XR-M
multi-turn LIVE test verifies on a real process boundary.

- Slice: 3-XR-F (CHANGELOG `[Slice 3-XR-B.1]` + `[Slice 3-XR-F]`),
  re-verified by 3-XR-M (multi-turn REPL LIVE).
- Evidence: `bin/naia-agent.ts` → `async function safeTurn(...)`.

### D-10. `stripRecallResidue` agent-loop sanitizer

Small models (e.g. `gemma3n:e4b`) emit malformed `<recall>` markers
(`<recalall>…`, `<recal_l>…`, `<recal<…`, stray `</recall>`). The strict
recall parser correctly ignores them, but raw streaming used to leak the
residue into user-visible text. A pure `stripRecallResidue(text)`
exported from `@nextain/agent-core` is now applied to the agent's final
`assistantText` on `turn.ended`. Strict match/act is unchanged
(cross-review invariant: leniency never reaches recall behavior). Bounded
match (`{0,256}`), line-anchored, marker-free input returned
byte-identical.

- Slice: 3-XR-F (CHANGELOG `[Slice 3-XR-D]`).
- Evidence: `packages/core/src/agent.ts` → `export function
  stripRecallResidue(text: string)` + `packages/core/src/index.ts` export
  + `bin/naia-agent.ts` use on `turn.ended`.

### D-11. `--memory` + `LiteMemoryProvider` CLI binding

`pnpm naia-agent --memory` switches from ephemeral `InMemoryMemory` to a
**persistent** `LiteMemoryProvider` (blessed `@nextain/naia-memory`
component) wired to the naia-settings `embedded` embedder + `<recall>`
recall protocol. DB defaults to `~/.naia-agent/memory/cli.sqlite`
(override with `NAIA_AGENT_MEMORY_DB`). Any embedder/DB failure degrades
gracefully back to in-memory — never crash over memory. Opt-in; default
behavior unchanged.

- Slice: 3-XR-C-mem (CHANGELOG `[Slice 3-XR-C]`).
- Evidence: `bin/naia-agent.ts` → `LiteMemoryProvider` import + the
  `--memory` branch in the CLI memory-provider factory; unit test
  `packages/runtime/src/__tests__/cli-memory.test.ts`.

### D-12. `--enable-file-ops` + `workspaceRoot` wiring

New `--enable-file-ops` toggle (default OFF — no behavior change) that
registers `read_file` / `write_file` / `edit_file` / `list_files`
alongside `bash`. The `workspaceRoot` is sourced from the existing
`--workdir` so D09 `normalizeWorkspacePath` enforces the boundary
consistently. Wired in **both** direct mode (`runDirect`) and service
mode (`runService`) so service manifests get the same protection.
General toggle — no per-model branching (`feedback_naia_agent_general
_purpose_no_overfit` guard preserved).

- Slice: 3-XR-I (CHANGELOG `[Slice 3-XR-I]`).
- Evidence: `bin/naia-agent.ts` → `--enable-file-ops` arg parsing +
  `createFileOpsSkills({ workspaceRoot: args.workdir })` in direct and
  service paths.

### D-13. `--skills-dir` + `FileSkillLoader` + `CompositeToolExecutor` + `normalizeInputSchemaForOllama`

Live loading of file-system SKILL.md skills under
`<root>/skills/**/SKILL.md` (or `onmam-adk/skills/`) via
`FileSkillLoader` and exposed to the LLM through a
`CompositeToolExecutor` that composes the skill executor on top of
`bash` + (optional) file-ops. Schemas are normalized for Ollama clients
via `normalizeInputSchemaForOllama` so OpenAI-shaped function-call
schemas round-trip cleanly. ADK-agnostic — naia-adk and onmam-adk share
the same machinery (Slice 3-XR-L verified onmam-adk needs zero bin/
runtime changes).

- Slice: 3-XR-J (CHANGELOG `[Slice 3-XR-J]` + 3-XR-L confirmation).
- Evidence: `bin/naia-agent.ts` → `--skills-dir` parsing +
  `CompositeToolExecutor` construction with `FileSkillLoader`;
  `packages/runtime/src/composite-tool-executor.ts`;
  `packages/runtime/src/skill-tool-bridge.ts` →
  `export function normalizeInputSchemaForOllama(...)`.

### D-14. `--repl` force REPL on non-TTY stdin

`--repl` forces the readline REPL loop regardless of stdin TTY status.
The default still treats piped stdin as a single-shot turn
(`readStdin` → one turn) per the existing design. `--repl` is the toggle
for harness multi-turn tests and shell pipelines that feed several
prompts. Model-agnostic, default OFF, no behavior change.

- Slice: 3-XR-M (CHANGELOG `[Slice 3-XR-M + 3-XR-N + 3-XR-O]` § M1/O2).
- Evidence: `bin/naia-agent.ts` → `--repl` arg parsing + the non-TTY
  branch in the REPL launcher.

### D-15. `--service backend=claude-code` subscription routing + DRYRUN gate

`*.service.json` manifests can declare `llm.backend: "claude-code"` to
route through the Claude Agent SDK (`ai-sdk-provider-claude-code`)
**using the user's Claude subscription** — no API key needed
(subscription-credit, per-account, capped, policy 2026-06-15). Same
pattern as runtime `coding-tool.ts`. The `NAIA_AGENT_DRYRUN=1` env gate
asserts the dispatcher arm without consuming subscription credit; opt-in
`NAIA_AGENT_CLAUDECODE_LIVE=1` executes a real one-turn call.

- Slice: 3-XR-G (manifest schema) / 3-XR-M (LIVE wire + DRYRUN gate)
  (CHANGELOG `[Slice 3-XR-G]` + `[Slice R6/SB-1.1]` + 3-XR-M § M2).
- Evidence: `bin/naia-agent.ts` → `case "claude-code"` in
  `buildLLMClientFromManifest` + the `NAIA_AGENT_DRYRUN` branch in
  `runService`.

### D-16. `langgraph` + `rag-retriever` reserved backend stubs

Service-manifest `llm.backend` accepts `"langgraph"` and
`"rag-retriever"` as **reserved values** so manifest authors can declare
intent ahead of the dispatcher implementation. The bin recognizes them,
prints a self-explaining stderr line, and exits cleanly (no silent
unknown-backend failure). Live dispatcher (LangGraph node routing / RAG
retriever + vector store + LLM hop) is deferred to Slice 3-XR-K
(business-adk).

- Slice: 3-XR-J piggyback / 3-XR-K deferred (CHANGELOG `[Slice 3-XR-J]`,
  Task #23 pending).
- Evidence: `bin/naia-agent.ts` → `case "langgraph": case
  "rag-retriever":` arm in `buildLLMClientFromManifest`.

### D-17. 3-judge ensemble (GLM + Claude CLI + Codex CLI), opt-in `NAIA_JUDGE_ENSEMBLE=1`

Integration-scenario LLM-as-judge has an opt-in **3-judge ensemble**
mode for the three high-judgment scenarios (A1 / A4 / F2): GLM (default
single judge) + `claude` CLI + `codex` CLI. Default OFF (single GLM) to
bound subscription costs — `NAIA_JUDGE_ENSEMBLE=1` enables ensemble. Each
ensemble-enabled run costs 3 scenarios × 3 judges = 9 API/CLI calls.
The other 23 scenarios stay single-GLM (mechanism-asserted, low
judgment).

- Slice: 3-XR-H (CHANGELOG `[Slice 3-XR-H]`).
- Evidence: `packages/cli-app/src/__tests__/integration-scenarios.test.ts`
  → `NAIA_JUDGE_ENSEMBLE` env gate around the A1/A4/F2 paths.
