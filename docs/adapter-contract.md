# Adapter Contract — SubAgentAdapter / Verifier / WorkspaceWatcher (R4 lock 2026-04-26)

> **Languages**: English (this file) · [한국어](../.users/docs/ko/adapter-contract.md)
>
> **Parents**: `docs/vision-statement.md` / `docs/architecture-hybrid.md`
> **Related**: `docs/stream-protocol.md` (NaiaStreamChunk)
> **Status**: design lock (Week 0)

---

## 1. Motivation

R4 Hybrid decision (D18) — wrap opencode / claude-code / future ACP-compliant agents as sub-agents. Adding a new sub-agent = one adapter package. Zero changes to core/cli.

To make that work we lock down **three standard contracts**:
1. `SubAgentAdapter` — spawn / control / receive events from a sub-agent
2. `Verifier` — automatic post-task verification (test/lint/build)
3. `WorkspaceWatcher` — real-time capture of workspace changes

---

## 2. SubAgentAdapter

### Interface

```typescript
// packages/types/src/sub-agent.ts

export type Capability =
  | "text_chat"          // general dialog
  | "code_edit"          // file edits
  | "shell_exec"         // bash and other command execution
  | "git_ops"            // git operations
  | "test_run"           // run tests
  | "browse_web"         // web fetch/search
  | "image_input"        // image input
  | "audio_input"        // voice input
  | "audio_output";      // voice cascade output (Slice 3-XR-Voice / P0c-2 — LiveKit + VoxCPM2 TTS at the agent layer, NOT in-model omni; cf project_minicpm_o_4_5_deprecated_2026_05_20)

export interface TaskSpec {
  readonly prompt: string;                   // user command
  readonly workdir: string;                  // sub-agent working directory
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraSystemPrompt?: string;       // injection point (alpha-memory recall result, etc.)
}

export interface SpawnContext {
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  readonly approvalBroker?: ApprovalBroker;  // T2/T3 tool approval
  readonly toolContext: ToolExecutionContext; // P0-4 (D25) — injected on every tool call
}

/**
 * P0-4 fix (Reference + Architect):
 * opencode Tool context schema (matrix D25). After spawn the adapter injects
 * this context into every tool call made by the sub-agent. Same pattern as
 * opencode / Vercel AI SDK.
 */
export interface ToolExecutionContext {
  readonly sessionId: string;          // naia-agent internal sub-agent session ID
  readonly workingDir: string;         // adapter cwd, the basis for sub-agent escape prevention
  readonly tier?: "T0" | "T1" | "T2" | "T3";  // matrix D05
  /**
   * Async approval RPC. Forwards the question to the supervisor, awaits user
   * approval, then returns the answer. T2/T3 tool calls invoke this callback
   * to obtain pre-approval. If undefined the adapter falls back to the
   * sub-agent's own approval logic (e.g. opencode's built-in flow).
   */
  readonly ask?: (question: string, meta?: { tool?: string; tier?: string }) => Promise<boolean>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  readonly startedAt: number;                // epoch ms

  /**
   * Live stream of NaiaStreamChunk events from this sub-agent.
   * Adapter MUST emit:
   *   - session_start (first)
   *   - tool_use_start / tool_use_end pairs (all tool calls)
   *   - workspace_change (if file modified, sourceSession=this.id)
   *   - text_delta (if applicable)
   *   - session_end (last, exactly once)
   * On cancel: interrupt followed by session_end(reason:"cancelled").
   */
  events(): AsyncIterable<NaiaStreamChunk>;

  /**
   * Hard cancel — terminate sub-agent immediately.
   * Resolves when session_end is emitted, or after timeout (default 5s).
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Soft pause — sub-agent finishes its current tool then halts.
   * Resume via resume(). If unsupported, throws UnsupportedError.
   */
  pause(): Promise<void>;
  resume(): Promise<void>;

  /**
   * Inject a system message mid-session (e.g. user feedback).
   * If unsupported, throws UnsupportedError.
   */
  inject(message: string): Promise<void>;

  status(): SubAgentStatus;
}

export type SubAgentStatus =
  | { phase: "starting" }
  | { phase: "running"; currentTool?: string }
  | { phase: "paused" }
  | { phase: "ended"; reason: "completed" | "cancelled" | "failed"; durationMs: number };

export interface SubAgentAdapter {
  readonly id: string;                       // "opencode-acp" | "opencode-cli" | "shell"
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly Capability[];

  spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession>;

  /**
   * Optional health check before spawn (e.g. binary present, API key valid).
   * Returns null if healthy, an error message otherwise.
   */
  health?(): Promise<string | null>;
}
```

### Contract tests (every adapter must pass)

Shared at `packages/adapters/__tests__/contract.ts`:

| # | Check |
|---|---|
| C1 | After `spawn`, the first chunk emitted by `events()` must be `session_start` |
| C2 | The last chunk emitted by `events()` must be `session_end` (exactly once) |
| C3 | After `cancel()`, `session_end(reason:"cancelled")` must arrive within 5s |
| C4 | `signal.abort()` behaves identically to `cancel()` |
| C5 | Every tool call emits a `tool_use_start` → `tool_use_end` pair (emit `start` without `end` = contract violation) |
| C6 | File modifications emit `workspace_change` (sourceSession=session.id) |
| C7 | If `pause`/`resume` is unsupported it must throw `UnsupportedError` (silent ignore forbidden) |
| C8 | If `health()` is defined it must be callable before spawn |
| C9 | `id`, `name`, `version`, and `capabilities` are all non-empty |
| C10 | Spawning two sessions from the same adapter concurrently keeps them isolated (no event leak) |
| C11 | **(P0-7)** Attempts to access paths outside `workdir` emit drop + warning (enforces matrix D09) |
| C12 | **(P0-7, Paranoid)** After `cancel()`, `session_end(reason:"cancelled")` must arrive within 500ms. If not, the supervisor escalates to SIGKILL. |
| C13 | **(P0-6)** Every emitted chunk must have secret patterns (sk-ant- / sk- / gw- / AIzaSy / Bearer) redacted |
| C14 | **(P0-5)** Calling an unsupported method (`pause`/`inject` etc.) must throw `UnsupportedError` |
| C15 | `session_end.reason` must be a value of the `SessionEndReason` enum (string literal union enforced) |

`tests/adapter-contract.spec.ts` verifies the suite passes against fake and real adapters alike.

### Implementation mapping

| Adapter id | Implementation | Control surface | Notes (verified 2026-05-20) |
|---|---|---|---|
| **`opencode-acp`** | In-tree JSON-RPC client (`AcpClient`) speaking the opencode Agent Client Protocol over stdio | ACP `session/new` / `session/update` / `session/cancel` | Package `@nextain/agent-adapter-opencode-acp` (workspace). No external `@agentclientprotocol/sdk` dep — the protocol client is implemented in-repo. |
| **`opencode-cli`** | Wraps `opencode run --format json` as a child process | stdout JSON line stream + SIGTERM | Package `@nextain/agent-adapter-opencode-cli` (workspace). Phase 1 fallback while ACP path matures. |
| **`shell`** | `child_process.spawn` of any external CLI | stdin/stdout passthrough + SIGTERM/SIGKILL | Package `@nextain/agent-adapter-shell` (workspace). Node.js built-ins only. |
| **`voice-cascade`** *(Slice 3-XR-Voice / P0c-2, deferred)* | LiveKit Agents framework (STT → LLM → VoxCPM2 TTS at the agent layer) | LiveKit cancel + fetch abort | Separate-session work; cf `project_voice_p0c_split_2026_05_20`. No package built yet. |
| **`mcp-bridge`** *(deferred)* | MCP server spawn | stdio MCP | — |

**Claude Code path (not an adapter).** Claude Code coding-agent integration is routed through the provider layer using `ai-sdk-provider-claude-code` (workspace dep `^3.4.4`, transitively `@anthropic-ai/claude-agent-sdk@0.2.122` for the platform-native binary), not through a dedicated `claude-code` `SubAgentAdapter`. See `packages/providers/src/vercel-client.ts` and Slice 3-XR-O (parity work, completed 2026-05-20).

### Unsupported methods matrix (P0-5 fix, Architect)

What each adapter supports vs. doesn't:

| method | opencode-acp | opencode-cli | shell | voice-cascade (deferred) |
|---|:---:|:---:|:---:|:---:|
| `spawn` | ✓ | ✓ | ✓ | ✓ |
| `events()` | ✓ | ✓ (stdout JSON) | ✓ (stdout/stderr) | ✓ (audio_delta) |
| `cancel()` | ✓ (ACP `session/cancel`) | ✓ (SIGTERM/SIGKILL) | ✓ (SIGTERM/SIGKILL) | ✓ (fetch abort) |
| `pause()` | △ (Phase 2 spike — confirm ACP spec) | ✗ | ✗ | ✗ |
| `resume()` | △ | ✗ | ✗ | ✗ |
| `inject(message)` | ✗ (no mid-session prompt) | ✗ | ✗ (stdin closed after spawn) | ✗ |
| `health()` | ✓ (ACP `initialize`) | ✓ (binary which) | ✓ (binary which) | ✓ (HTTP HEAD) |
| `status()` | ✓ | ✓ | ✓ | ✓ |

**Rule**: calling an unsupported method must throw `UnsupportedError` (silent ignore forbidden). The supervisor checks `adapter.capabilities` before spawn.

`△` = to be confirmed by a spike when the phase begins. Assume unsupported until then.

---

## 3. opencode ACP mapping (detail)

| ACP message | NaiaStreamChunk | Notes |
|---|---|---|
| `initialize` (request) | (internal) | Once at adapter ctor |
| `session/new` (request) | (internal) — response yields the sessionId | First step of spawn |
| `session/prompt` (request) | (forwarded to sub-agent prompt) | `task.prompt` |
| `session/update` notification | `tool_use_start` or `tool_use_end` or `workspace_change` | Branched on `update.kind` |
| `session/request_permission` (request from agent) | `tool_use_start` (tier populated) → host approval → response | T2/T3 gate |
| `session/cancel` (request) | (internal) | On `cancel()` |
| `session/done` notification | `session_end(reason: completed)` | Normal termination |
| stderr / abnormal exit | `session_end(reason: failed)` | Adapter's responsibility |

---

## 4. Claude Agent SDK mapping (detail)

Used by the provider layer via `ai-sdk-provider-claude-code` (not a SubAgentAdapter). Listed here for symmetry — when/if a `claude-code` adapter is added, this is the event mapping to follow.

| SDK call | NaiaStreamChunk |
|---|---|
| `new Session({ workdir })` | (internal) |
| session iter (`for await ... of session`) | event branch |
| `event.type === "tool_use_started"` | `tool_use_start` |
| `event.type === "tool_use_completed"` | `tool_use_end` |
| `event.type === "file_edited"` | `workspace_change` |
| `event.type === "thinking"` | `thinking_delta` |
| `event.type === "text"` | `text_delta` |
| `session.cancel()` | `interrupt` + `session_end(cancelled)` |
| iter end | `session_end(completed)` |

(Exact SDK API will be re-checked by a spike when needed. The spec above is provisional.)

---

## 5. Verifier

### Interface

```typescript
// packages/types/src/verification.ts

export interface VerifierContext {
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  readonly env?: Readonly<Record<string, string>>;
}

export interface VerificationResult {
  readonly runner: string;
  readonly pass: boolean;
  readonly stats: VerificationStats;
  readonly durationMs: number;
  readonly stdoutTail?: string;
  readonly errorTail?: string;
}

export interface Verifier {
  readonly id: "test" | "lint" | "build" | "type_check" | string;
  readonly defaultCommand: string;        // e.g. "pnpm test", "pnpm lint"

  /**
   * Run verifier in workdir. Returns result; never throws on failure
   * (failure is `pass: false`). Throws only on infrastructure error.
   */
  run(workdir: string, ctx: VerifierContext): Promise<VerificationResult>;
}
```

### Standard implementations (Phase 1)

| Verifier | command | parse |
|---|---|---|
| **TestVerifier** | `pnpm test` | vitest output → passed/failed/total |
| **LintVerifier** | `pnpm lint` | eslint/oxlint exit code + stdout count |
| **BuildVerifier** | `pnpm build` | tsc --build exit code |
| **TypeCheckVerifier** | `pnpm typecheck` | tsc --noEmit exit code |

Each verifier is independent — the orchestrator may run them in parallel.

---

## 6. WorkspaceWatcher

### Interface

```typescript
// packages/types/src/workspace.ts

export interface WorkspaceChange {
  readonly path: string;                   // workdir-relative
  readonly kind: "add" | "modify" | "delete";
  readonly timestamp: number;              // epoch ms
  readonly sourceSession?: string;         // tracked when possible, undefined otherwise
}

export interface WorkspaceWatcher {
  /**
   * Watch workdir for changes. Yields WorkspaceChange events.
   * Debounced internally (default 100ms).
   * Stops on signal.aborted.
   */
  watch(workdir: string, signal: AbortSignal): AsyncIterable<WorkspaceChange>;

  /**
   * Compute git-style diff for path. Lazy — caller invokes when needed.
   * Returns null if not in a git repo or path unchanged.
   */
  diff(workdir: string, path: string): Promise<string | null>;

  /**
   * Aggregate stats (additions/deletions) for path or whole workdir.
   */
  stats(workdir: string, path?: string): Promise<{ additions: number; deletions: number }>;
}
```

### Standard implementation (Phase 1)

`packages/workspace/src/`:
- `chokidar-watcher.ts` — chokidar-based watch + 100ms debounce + .gitignore filter
- `git-diff.ts` — `git diff --numstat` + `git diff -- <path>`

---

## 7. Performance + stability contract

| Item | Guarantee |
|---|---|
| spawn latency | ≤ 5s (opencode / Claude Code startup time) |
| cancel responsiveness | hard kill ≤ 5s / soft pause ≤ 30s (depends on the current tool) |
| event order | strictly ordered within a single session |
| event delivery | best-effort (on network drop: timeout + session_end emitted) |
| memory | event chunk size ≤ 64 KiB recommended (split large audio/image payloads) |
| concurrent sessions | at least 4 in Phase 1; N validated in Phase 3 |
| watcher debounce | 100ms (configurable) |
| verification timeout | default 5 minutes per runner (configurable) |

---

## 8. Security contract

| Item | Enforcement |
|---|---|
| **workdir isolation** | Sub-agent must not escape `TaskSpec.workdir`. Adapter enforces this via the `cwd` option. Phase 2+ adds further hardening (chroot/seccomp under review — Paranoid M1). |
| **env minimization** | Only entries listed in `TaskSpec.env` are passed to the child. Indiscriminate `process.env` forwarding is forbidden. |
| **secret redact (P0-6)** | **Every `SubAgentEvent → NaiaStreamChunk` conversion site is a mandatory `redact` wrapper** — `adapters/*/event-converter.ts` calls `redactSecrets()` from `observability/redact.ts` before emit. Five patterns (sk-ant- / sk- / gw- / AIzaSy / Bearer), Slice 2.7. |
| **redact target fields** | `text_delta.text` / `tool_use_start.input` / `tool_use_end.result` / `verification_result.stdoutTail` / `report.summary`. Binary payloads (audio/image) excluded. |
| **redact contract test** | C13 — "ACP `session/update` with `Authorization: Bearer sk-xxx` in tool input → emitted chunk must be redacted." |
| **approval gate** | At T2/T3 tool start, populate `tool_use_start.tier` to notify the host. Do not execute until host approval arrives. Use `SpawnContext.toolContext.ask`. |
| **DANGEROUS regex** | Pre-scan `input.command` for bash tool calls (reuses matrix D02, layered above opencode's own security) — Phase 2+. |
| **path traversal** | If `workspace_change.path` points outside `workdir`, drop the emit and log a warning (matrix D09). |
| **trust assumption** | Trust the adapter implementation (opencode / claude-code) to enforce its own security. The naia-agent layer adds isolation + audit trail on top (Paranoid P2-4). |

---

## 9. Change procedure after R4 lock

Add a new adapter:
1. Create `packages/adapters/<id>/`
2. Pass every contract test (`pnpm test --filter @nextain/adapter-<id>`)
3. Add matrix §D entry (new D## id)
4. Cross-review (architect + paranoid)
5. README/CHANGELOG entry

Change the interfaces themselves:
1. Update this file + add a change log
2. Update `packages/types/src/{sub-agent,verification,workspace}.ts`
3. Update every existing adapter (breaking change permitted)
4. Update fixtures
5. Cross-review (3-perspective)
