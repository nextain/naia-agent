import path from "node:path";
import { redactString } from "@nextain/agent-observability";
import {
  type Capability,
  type NaiaStreamChunk,
  type SessionEndReason,
  type SpawnContext,
  type SubAgentAdapter,
  type SubAgentSession,
  type SubAgentStatus,
  type TaskSpec,
  UnsupportedError,
} from "@nextain/agent-types";
import { AcpClient } from "./acp-client.js";

const DEFAULT_CAPS: readonly Capability[] = [
  "text_chat",
  "code_edit",
  "shell_exec",
  "git_ops",
  "test_run",
];

const HARD_KILL_DEADLINE_MS = 500;
const ACP_PROTOCOL_VERSION = 1;

export interface OpencodeAcpAdapterOptions {
  /** opencode binary command. Default: `npx opencode-ai@1.14.25`. */
  binary?: { command: string; prefixArgs: readonly string[] };
  /** Hard kill deadline in ms (C12 contract). Default 500. */
  hardKillDeadlineMs?: number;
}

export class OpencodeAcpAdapter implements SubAgentAdapter {
  readonly id = "opencode-acp";
  readonly name = "OpencodeAcpAdapter";
  readonly version = "0.1.0";
  readonly capabilities = DEFAULT_CAPS;
  readonly #opts: OpencodeAcpAdapterOptions;

  constructor(opts: OpencodeAcpAdapterOptions = {}) {
    this.#opts = opts;
  }

  async health(): Promise<string | null> {
    // D34 — adapter health check: spawn a probe, send `initialize`, expect protocolVersion=1
    const bin = this.#resolveBin();
    const probe = new AcpClient({
      command: bin.command,
      args: [...bin.prefixArgs, "acp"],
      hardKillDeadlineMs: 1000,
    });
    try {
      const result = await probe.request<{ protocolVersion: number }>(
        "initialize",
        { protocolVersion: ACP_PROTOCOL_VERSION },
      );
      if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        return `unexpected protocolVersion: ${String(result?.protocolVersion)}`;
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await probe.close().catch(() => undefined);
    }
  }

  async spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession> {
    const bin = this.#resolveBin();
    const workdir = path.resolve(task.workdir);

    // D40 / Reference P0-3 — inject ToolExecutionContext via env vars
    const naiaEnv: Record<string, string> = {};
    if (ctx.toolContext.sessionId !== undefined) {
      naiaEnv["NAIA_SESSION_ID"] = ctx.toolContext.sessionId;
    }
    if (ctx.toolContext.workingDir !== undefined) {
      naiaEnv["NAIA_WORKDIR"] = ctx.toolContext.workingDir;
    }
    if (ctx.toolContext.tier !== undefined) {
      naiaEnv["NAIA_TIER"] = ctx.toolContext.tier;
    }

    // P1-1 (Phase 1 carry-over) — opencode needs LLM provider credentials.
    // Forward parent env (intentional) + NAIA_* + task.env overrides.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...naiaEnv,
      ...(task.env ?? {}),
    };

    const client = new AcpClient({
      command: bin.command,
      args: [...bin.prefixArgs, "acp"],
      cwd: workdir,
      env,
      hardKillDeadlineMs: this.#opts.hardKillDeadlineMs ?? HARD_KILL_DEADLINE_MS,
    });

    // Initialize ACP
    const initResult = await client.request<{ protocolVersion: number }>(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION },
    );
    if (initResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
      await client.close();
      throw new Error(
        `opencode acp protocolVersion mismatch: ${initResult.protocolVersion}`,
      );
    }

    // Create session — ACP NewSessionRequest schema (cwd + mcpServers required)
    const session = await client.request<{ sessionId: string }>(
      "session/new",
      { cwd: workdir, mcpServers: [] },
    );

    return new OpencodeAcpSession({
      acpClient: client,
      sessionId: session.sessionId,
      adapterId: this.id,
      workdir,
      ctx,
      taskPrompt: task.prompt,
    });
  }

  #resolveBin(): { command: string; prefixArgs: readonly string[] } {
    if (this.#opts.binary) return this.#opts.binary;
    const envBin = process.env["OPENCODE_BIN"];
    if (envBin && envBin.length > 0) {
      return { command: envBin, prefixArgs: [] };
    }
    return { command: "npx", prefixArgs: ["--yes", "opencode-ai@1.14.25"] };
  }
}

interface OpencodeAcpSessionInit {
  acpClient: AcpClient;
  sessionId: string;
  adapterId: string;
  workdir: string;
  ctx: SpawnContext;
  taskPrompt: string;
}

class OpencodeAcpSession implements SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  readonly startedAt: number;

  readonly #client: AcpClient;
  readonly #acpSessionId: string;
  readonly #ctx: SpawnContext;
  #status: SubAgentStatus;
  #queue: NaiaStreamChunk[] = [];
  #waiters: Array<(value: IteratorResult<NaiaStreamChunk>) => void> = [];
  #ended = false;
  #liveTools = new Map<string, { tool: string; startedAt: number }>();

  constructor(init: OpencodeAcpSessionInit) {
    this.id = `opencode-acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.adapterId = init.adapterId;
    this.startedAt = Date.now();
    this.#client = init.acpClient;
    this.#acpSessionId = init.sessionId;
    this.#ctx = init.ctx;
    this.#status = { phase: "running" };

    // Emit session_start
    this.#emit({
      type: "session_start",
      sessionId: this.id,
      adapterId: init.adapterId,
      taskSummary: `opencode acp: ${init.taskPrompt.slice(0, 80)}`,
      workdir: init.workdir,
    });

    // Wire ACP notifications → NaiaStreamChunk
    this.#client.onNotification("session/update", (note) => {
      if (process.env["NAIA_DEBUG_ACP"]) {
        process.stderr.write(
          `[acp/update] ${JSON.stringify(note.params).slice(0, 800)}\n`,
        );
      }
      this.#handleSessionUpdate(note.params);
    });

    // Bidirectional — server requests permission from us
    this.#client.onServerRequest((method, params) => {
      if (method === "session/request_permission") {
        return this.#handleRequestPermission(params);
      }
      return Promise.reject(new Error(`Unhandled ACP request: ${method}`));
    });

    // Send the prompt — ACP PromptRequest schema (prompt: ContentBlock[])
    void this.#client
      .request("session/prompt", {
        sessionId: init.sessionId,
        prompt: [{ type: "text", text: init.taskPrompt }],
      })
      .then(() => this.#emitEnd("completed"))
      .catch((err: Error) => {
        if (!this.#ended) {
          this.#emit({
            type: "text_delta",
            sessionId: this.id,
            text: `[acp error] ${redactString(err.message)}`,
          });
          this.#emitEnd("failed");
        }
      });

    // Signal forwarding
    if (init.ctx.signal.aborted) {
      void this.cancel("signal aborted at spawn");
    } else {
      init.ctx.signal.addEventListener(
        "abort",
        () => {
          void this.cancel("signal aborted");
        },
        { once: true },
      );
    }
  }

  // ─── handlers ───────────────────────────────────────────────

  #handleSessionUpdate(params: unknown): void {
    if (this.#ended) return;
    const u = params as {
      sessionId?: string;
      update?: {
        sessionUpdate?: string;
        // Verified via spike (2026-04-26 NAIA_DEBUG_ACP=1):
        // - agent_message_chunk / agent_thought_chunk: { content: { type: "text", text: "..." } }
        // - tool_call_*: { toolCallId, status, rawInput, rawOutput, title }
        content?: { type?: string; text?: string };
        toolCallId?: string;
        title?: string;
        status?: string;
        rawInput?: unknown;
        rawOutput?: unknown;
      };
    };
    const update = u.update;
    if (!update) return;
    const kind = update.sessionUpdate;
    const text = update.content?.text;

    // Final assistant message text
    if (kind === "agent_message_chunk" && typeof text === "string" && text.length > 0) {
      this.#emit({
        type: "text_delta",
        sessionId: this.id,
        text: redactString(text),
      });
      return;
    }

    // Reasoning / thinking text (Phase 1: emit as thinking_delta)
    if (kind === "agent_thought_chunk" && typeof text === "string" && text.length > 0) {
      this.#emit({
        type: "thinking_delta",
        sessionId: this.id,
        thinking: redactString(text),
      });
      return;
    }

    // Tool call lifecycle — opencode emits flat fields on update (not nested toolCall)
    if (kind === "tool_call" || kind === "tool_call_start" || kind === "tool_call_update") {
      const tcid = update.toolCallId ?? "unknown";
      const status = update.status ?? "pending";
      if (status === "pending" || status === "running" || status === "in_progress") {
        if (!this.#liveTools.has(tcid)) {
          this.#liveTools.set(tcid, {
            tool: update.title ?? "unknown",
            startedAt: Date.now(),
          });
          this.#emit({
            type: "tool_use_start",
            sessionId: this.id,
            toolUseId: tcid,
            tool: update.title ?? "unknown",
            input: this.#redactDeep(update.rawInput),
          });
        }
      } else if (status === "completed" || status === "failed") {
        const live = this.#liveTools.get(tcid);
        if (!live) {
          // synth start+end
          this.#emit({
            type: "tool_use_start",
            sessionId: this.id,
            toolUseId: tcid,
            tool: update.title ?? "unknown",
            input: this.#redactDeep(update.rawInput),
          });
        }
        const startedAt = live?.startedAt ?? Date.now();
        this.#liveTools.delete(tcid);
        this.#emit({
          type: "tool_use_end",
          sessionId: this.id,
          toolUseId: tcid,
          tool: live?.tool ?? update.title ?? "unknown",
          result: this.#redactDeep(update.rawOutput),
          ok: status === "completed",
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    // usage_update / plan / etc. — silently skip in Phase 2
  }

  async #handleRequestPermission(params: unknown): Promise<unknown> {
    const p = params as {
      sessionId?: string;
      toolCall?: { title?: string };
      options?: Array<{ optionId?: string; name?: string; kind?: string }>;
    };
    const tool = p.toolCall?.title ?? "tool";
    const options = p.options ?? [];

    // P0-2 (Paranoid) — ApprovalBroker bypass via "always allow"
    // We restrict to "once" semantics: only allow_once / reject. Strip
    // "allow_always" options before passing to user broker.
    const broker = this.#ctx.approvalBroker;
    if (!broker) {
      // No broker injected — default deny
      const reject = options.find((o) => o.kind === "reject");
      return { outcome: { outcome: "selected", optionId: reject?.optionId ?? "reject" } };
    }
    const decision = await broker.decide({
      id: `acp-${Date.now()}`,
      invocation: {
        id: `acp-${Date.now()}`,
        name: tool,
        input: {},
        tier: "T2",
      },
      tier: "T2",
      reason: `${tool} requires permission (sub-agent ACP)`,
    });
    if (decision.status === "approved") {
      // P0-2 (Paranoid) — explicit "once" semantics; never select allow_always
      const allowOnce =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind === "allow");
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOnce?.optionId ?? "allow_once",
        },
      };
    }
    const reject = options.find((o) => o.kind === "reject");
    return {
      outcome: {
        outcome: "selected",
        optionId: reject?.optionId ?? "reject",
      },
    };
  }

  #redactDeep(input: unknown): unknown {
    if (input == null) return input;
    if (typeof input === "string") return redactString(input);
    if (Array.isArray(input)) return input.map((v) => this.#redactDeep(v));
    if (typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = this.#redactDeep(v);
      }
      return out;
    }
    return input;
  }

  // ─── async iterable plumbing ────────────────────────────────

  #emit(chunk: NaiaStreamChunk): void {
    if (this.#ended) return;
    if (this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      w({ value: chunk, done: false });
    } else {
      this.#queue.push(chunk);
    }
  }

  #emitEnd(reason: SessionEndReason): void {
    if (this.#ended) return;
    this.#emit({ type: "session_end", sessionId: this.id, reason });
    this.#status = {
      phase: "ended",
      reason,
      durationMs: Date.now() - this.startedAt,
    };
    this.#ended = true;
    while (this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      w({ value: undefined as never, done: true });
    }
    void this.#client.close().catch(() => undefined);
  }

  events(): AsyncIterable<NaiaStreamChunk> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<NaiaStreamChunk> {
        return {
          async next(): Promise<IteratorResult<NaiaStreamChunk>> {
            if (self.#queue.length > 0) {
              return { value: self.#queue.shift()!, done: false };
            }
            if (self.#ended) {
              return { value: undefined as never, done: true };
            }
            return new Promise((resolve) => self.#waiters.push(resolve));
          },
        };
      },
    };
  }

  async cancel(reason?: string): Promise<void> {
    if (this.#ended) return;
    this.#emit({
      type: "interrupt",
      sessionId: this.id,
      reason: reason ?? "cancelled",
      mode: "hard_kill",
    });
    // Try graceful ACP cancel first
    try {
      this.#client.notify("session/cancel", { sessionId: this.#acpSessionId });
    } catch {
      /* ignore */
    }
    // Then close stdin (which triggers child shutdown), AcpClient enforces
    // hard kill deadline (C12).
    await this.#client.close();
    if (!this.#ended) this.#emitEnd("cancelled");
  }

  async pause(): Promise<void> {
    // D39 — opencode ACP does not expose `pause` capability (verified spike)
    throw new UnsupportedError(this.adapterId, "pause");
  }
  async resume(): Promise<void> {
    // resume is in sessionCapabilities but not used in Phase 2 (Phase 3+)
    throw new UnsupportedError(this.adapterId, "resume");
  }
  async inject(_message: string): Promise<void> {
    throw new UnsupportedError(this.adapterId, "inject");
  }

  status(): SubAgentStatus {
    return this.#status;
  }
}
