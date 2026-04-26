/**
 * SubAgentAdapter — wraps an external coding agent (opencode / claude-code /
 * shell / vllm-omni / mcp-bridge) behind a single contract.
 *
 * Spec: docs/adapter-contract.md (R4 lock 2026-04-26)
 *
 * Adopted decisions: D18 (Hybrid wrapper) + D24 (supervisor) + D25 (Tool context).
 * Phase 1 implementations: shell, opencode-cli (`opencode run --format json`).
 */
import type { ApprovalBroker } from "./approval.js";
import type { Logger } from "./observability.js";
import type { NaiaStreamChunk, SessionEndReason } from "./stream.js";
import type { ToolExecutionContext } from "./tool.js";

export type Capability =
  | "text_chat"
  | "code_edit"
  | "shell_exec"
  | "git_ops"
  | "test_run"
  | "browse_web"
  | "image_input"
  | "audio_input"
  | "audio_output";

export interface TaskSpec {
  readonly prompt: string;
  readonly workdir: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** alpha-memory recall result, system prompt augmentation. Phase 3+. */
  readonly extraSystemPrompt?: string;
}

/**
 * SpawnContext — runtime context the supervisor passes to every adapter.spawn().
 * D25 — toolContext (from tool.ts) is propagated to sub-agent's tool calls.
 */
export interface SpawnContext {
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  readonly approvalBroker?: ApprovalBroker;
  readonly toolContext: ToolExecutionContext;
}

export type SubAgentStatus =
  | { phase: "starting" }
  | { phase: "running"; currentTool?: string }
  | { phase: "paused" }
  | {
      phase: "ended";
      reason: SessionEndReason;
      durationMs: number;
    };

export interface SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  readonly startedAt: number;

  /**
   * Live stream of NaiaStreamChunk events.
   * Adapter MUST emit:
   *   - session_start (first chunk)
   *   - tool_use_start/end pairs (per tool call)
   *   - workspace_change (if file modified, sourceSession=this.id)
   *   - text_delta (if applicable)
   *   - session_end (last chunk, exactly once)
   * On cancel: interrupt then session_end(reason: "cancelled").
   */
  events(): AsyncIterable<NaiaStreamChunk>;

  /**
   * Hard cancel. Resolves when session_end emitted or 500ms hard deadline
   * (P0-7, contract test C12). Adapter MUST send SIGTERM then SIGKILL.
   */
  cancel(reason?: string): Promise<void>;

  /** Soft pause. Throws UnsupportedError if adapter doesn't support. */
  pause(): Promise<void>;
  resume(): Promise<void>;

  /** Inject system message mid-session. Throws UnsupportedError if unsupported. */
  inject(message: string): Promise<void>;

  status(): SubAgentStatus;
}

export interface SubAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly Capability[];

  spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession>;

  /** Optional pre-spawn health check. null = healthy. */
  health?(): Promise<string | null>;
}

export class UnsupportedError extends Error {
  constructor(adapterId: string, method: string) {
    super(`Adapter ${adapterId} does not support ${method}()`);
    this.name = "UnsupportedError";
  }
}

export class WorkspaceEscapeError extends Error {
  constructor(workdir: string, attemptedPath: string) {
    super(
      `Sub-agent attempted to access path outside workdir: ${attemptedPath} (workdir: ${workdir})`,
    );
    this.name = "WorkspaceEscapeError";
  }
}
