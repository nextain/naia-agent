/**
 * Agent — keystone loop that wires HostContext contracts together.
 *
 * Designed against references: careti (naia-os/agent), opencode's
 * session/compaction, claude-code patterns, with alpha-memory's
 * consolidation model as the first-class integration target.
 *
 * Key design choices:
 *   1. **Stream-first**. `sendStream()` yields structured events; `send()`
 *      is a convenience wrapper that drains the stream and returns text.
 *   2. **Memory-driven context**. Recall at turn start, encode at turn end,
 *      delegate compaction to `MemoryProvider` when `CompactableCapable`.
 *      Real-time compaction (future alpha-memory) plugs in transparently.
 *   3. **Tool-hop loop** with approval via `HostContext.tools` (wrap with
 *      `GatedToolExecutor` for tier policy).
 *   4. **Session lifecycle** — Agent owns a Session and transitions it
 *      through ALLOWED_TRANSITIONS; emits session.* events via Logger.
 *   5. **Budget hook** — before each LLM call, check token budget via a
 *      provided estimator; if exceeded and memory is `CompactableCapable`,
 *      compact the message history in place.
 */

import type {
  CompactableCapable,
  CompactionMessage,
  HostContext,
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMStreamChunk,
  LLMUsage,
  MemoryHit,
  Session,
  SessionState,
  StopReason,
  ToolExecutionResult,
  ToolInvocation,
  TierLevel,
} from "@nextain/agent-types";
import { ALLOWED_TRANSITIONS, isCapable } from "@nextain/agent-types";

export interface AgentOptions {
  host: HostContext;
  /** Optional system prompt, inserted as top-level `system` field. */
  systemPrompt?: string;
  /** Override default model (otherwise provider default is used). */
  model?: string;
  /** Maximum tool-use iterations per `send()` call. Default 10. */
  maxToolHops?: number;
  /**
   * Estimate token count for a request. Agent-facing hook so callers can
   * plug in provider-accurate tokenizers. Default: rough char/4 heuristic.
   */
  estimateTokens?: (req: LLMRequest) => number;
  /**
   * Soft token budget. When the estimated request exceeds this, agent
   * attempts compaction (if memory is CompactableCapable). Default: 80_000.
   */
  contextBudget?: number;
  /**
   * Tail messages preserved verbatim during compaction. Default: 6.
   * (3 user/assistant turn pairs, roughly.)
   */
  compactionKeepTail?: number;
  /**
   * Tier resolver — given a tool name, returns its tier. Host plugs in a
   * skill-spec lookup. Default: T1 (safe assumption).
   */
  tierForTool?: (name: string) => TierLevel;
}

/** Events emitted by `sendStream()`. Callers pattern-match on `type`. */
export type AgentStreamEvent =
  | { type: "session.started"; session: Readonly<Session> }
  | { type: "turn.started"; userText: string; recalled: number }
  | { type: "llm.chunk"; chunk: LLMStreamChunk }
  | { type: "tool.started"; invocation: ToolInvocation }
  | { type: "tool.ended"; invocation: ToolInvocation; result: ToolExecutionResult }
  | { type: "compaction"; droppedCount: number; realtime: boolean }
  | { type: "usage"; usage: LLMUsage }
  | { type: "turn.ended"; assistantText: string }
  | { type: "session.ended"; state: SessionState };

export class Agent {
  readonly #host: HostContext;
  readonly #session: Session;
  readonly #history: LLMMessage[] = [];
  readonly #model?: string;
  readonly #system?: string;
  readonly #maxHops: number;
  readonly #estimate: (req: LLMRequest) => number;
  readonly #budget: number;
  readonly #keepTail: number;
  readonly #tierFor: (name: string) => TierLevel;

  constructor(options: AgentOptions) {
    this.#host = options.host;
    if (options.model !== undefined) this.#model = options.model;
    if (options.systemPrompt !== undefined) this.#system = options.systemPrompt;
    this.#maxHops = options.maxToolHops ?? 10;
    this.#estimate = options.estimateTokens ?? defaultEstimate;
    this.#budget = options.contextBudget ?? 80_000;
    this.#keepTail = options.compactionKeepTail ?? 6;
    this.#tierFor = options.tierForTool ?? (() => "T1");

    this.#session = {
      id: randomSessionId(),
      state: "created",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#transitionTo("active");
  }

  /** Read-only session snapshot. */
  get session(): Readonly<Session> {
    return this.#session;
  }

  /** Convenience: drain the stream and return the final assistant text. */
  async send(userText: string, signal?: AbortSignal): Promise<string> {
    let finalText = "";
    for await (const ev of this.sendStream(userText, signal)) {
      if (ev.type === "turn.ended") finalText = ev.assistantText;
    }
    return finalText;
  }

  /** Stream-first entry point. Yields structured events throughout the turn. */
  async *sendStream(
    userText: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    if (this.#session.state !== "active") {
      throw new Error(`Cannot send — session is "${this.#session.state}"`);
    }

    yield { type: "session.started", session: this.#session };

    // 1. Recall memory for context.
    const hits = await this.#recallMemory(userText);
    this.#history.push({ role: "user", content: userText });
    yield { type: "turn.started", userText, recalled: hits.length };

    let hopsRemaining = this.#maxHops;
    let finalText = "";
    const aggUsage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    while (hopsRemaining-- > 0) {
      if (signal?.aborted) break;

      // 2. Budget check → delegate compaction to memory if capable.
      const compactEvent = await this.#maybeCompact();
      if (compactEvent) yield compactEvent;

      // 3. Build + stream LLM request.
      const request = this.#buildRequest(hits);
      const { blocks, stopReason, usage } = yield* this.#streamLLM(request, signal);
      aggUsage.inputTokens += usage.inputTokens;
      aggUsage.outputTokens += usage.outputTokens;
      if (usage.cacheReadTokens !== undefined) {
        aggUsage.cacheReadTokens =
          (aggUsage.cacheReadTokens ?? 0) + usage.cacheReadTokens;
      }
      if (usage.cacheWriteTokens !== undefined) {
        aggUsage.cacheWriteTokens =
          (aggUsage.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      }

      // Commit assistant turn to history (so next iteration sees tool_use).
      this.#history.push({ role: "assistant", content: blocks });

      if (stopReason !== "tool_use") {
        finalText = extractText(blocks);
        break;
      }

      // 4. Tool-hop: execute each tool_use, push tool_result turn.
      const toolResults: LLMContentBlock[] = [];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        if (signal?.aborted) break;
        const invocation: ToolInvocation = {
          id: block.id,
          name: block.name,
          input: block.input,
          tier: this.#tierFor(block.name),
          sessionId: this.#session.id,
        };
        yield { type: "tool.started", invocation };
        const result = await this.#executeTool(invocation, signal);
        yield { type: "tool.ended", invocation, result };
        toolResults.push({
          type: "tool_result",
          toolCallId: block.id,
          content: result.content,
          ...(result.isError === true ? { isError: true } : {}),
        });
      }
      this.#history.push({ role: "tool", content: toolResults });
    }

    if (!finalText) {
      this.#host.logger.warn("agent.send.max_hops_or_abort", {
        sessionId: this.#session.id,
        aborted: signal?.aborted ?? false,
        remainingHops: hopsRemaining,
      });
      finalText = signal?.aborted
        ? "[agent aborted]"
        : "[agent stopped — reached max tool-hop budget]";
    }

    yield { type: "usage", usage: aggUsage };
    await this.#encodeTurn(userText, finalText);
    yield { type: "turn.ended", assistantText: finalText };
  }

  /** End the session. Further `send()` calls throw. */
  async close(): Promise<void> {
    if (this.#session.state === "closed" || this.#session.state === "failed") return;
    this.#transitionTo("closed");
    try {
      await this.#host.memory.close();
    } catch (err) {
      this.#host.logger.warn("agent.memory.close.error", { err: String(err) });
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  async #recallMemory(query: string): Promise<MemoryHit[]> {
    try {
      return await this.#host.memory.recall(query, { topK: 5 });
    } catch (err) {
      this.#host.logger.warn("agent.memory.recall.error", { err: String(err) });
      return [];
    }
  }

  #buildRequest(memoryHits: MemoryHit[]): LLMRequest {
    const systemParts: string[] = [];
    if (this.#system) systemParts.push(this.#system);
    if (memoryHits.length > 0) {
      const recalled = memoryHits.map((h) => `- ${h.content}`).join("\n");
      systemParts.push(`Relevant context from memory:\n${recalled}`);
    }
    const req: LLMRequest = { messages: this.#history };
    if (this.#model !== undefined) req.model = this.#model;
    if (systemParts.length > 0) req.system = systemParts.join("\n\n");
    return req;
  }

  /**
   * Streaming helper — consumes `llm.stream()`, forwards chunks as
   * AgentStreamEvents, accumulates final block/stopReason/usage.
   */
  async *#streamLLM(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent, {
    blocks: LLMContentBlock[];
    stopReason: StopReason;
    usage: LLMUsage;
  }> {
    const blocks: LLMContentBlock[] = [];
    let stopReason: StopReason = "end_turn";
    const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    const reqWithSignal: LLMRequest = { ...request };
    if (signal) reqWithSignal.signal = signal;

    for await (const chunk of this.#host.llm.stream(reqWithSignal)) {
      yield { type: "llm.chunk", chunk };
      if (chunk.type === "content_block_start") {
        blocks[chunk.index] = chunk.block;
      } else if (chunk.type === "content_block_delta") {
        applyDelta(blocks, chunk.index, chunk.delta);
      } else if (chunk.type === "usage") {
        if (chunk.usage.inputTokens !== undefined) usage.inputTokens = chunk.usage.inputTokens;
        if (chunk.usage.outputTokens !== undefined) usage.outputTokens = chunk.usage.outputTokens;
        if (chunk.usage.cacheReadTokens !== undefined) usage.cacheReadTokens = chunk.usage.cacheReadTokens;
        if (chunk.usage.cacheWriteTokens !== undefined) usage.cacheWriteTokens = chunk.usage.cacheWriteTokens;
      } else if (chunk.type === "end") {
        stopReason = chunk.stopReason;
        usage.inputTokens = chunk.usage.inputTokens;
        usage.outputTokens = chunk.usage.outputTokens;
        if (chunk.usage.cacheReadTokens !== undefined) usage.cacheReadTokens = chunk.usage.cacheReadTokens;
        if (chunk.usage.cacheWriteTokens !== undefined) usage.cacheWriteTokens = chunk.usage.cacheWriteTokens;
      }
    }
    return { blocks: blocks.filter((b): b is LLMContentBlock => b !== undefined), stopReason, usage };
  }

  async #executeTool(
    invocation: ToolInvocation,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    try {
      return await this.#host.tools.execute(invocation, signal);
    } catch (err) {
      this.#host.logger.error(
        "agent.tool.exception",
        err instanceof Error ? err : undefined,
        { name: invocation.name },
      );
      return {
        content: `tool "${invocation.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  async #encodeTurn(userText: string, assistantText: string): Promise<void> {
    try {
      await this.#host.memory.encode({
        content: userText,
        role: "user",
        context: { sessionId: this.#session.id },
      });
      await this.#host.memory.encode({
        content: assistantText,
        role: "assistant",
        context: { sessionId: this.#session.id },
      });
    } catch (err) {
      this.#host.logger.warn("agent.memory.encode.error", { err: String(err) });
    }
  }

  /**
   * If the memory provider implements `CompactableCapable` and the current
   * request exceeds the soft budget, delegate compaction. Updates
   * `this.#history` in place. Returns an AgentStreamEvent to yield, or
   * undefined if no compaction was performed.
   */
  async #maybeCompact(): Promise<AgentStreamEvent | undefined> {
    const request = this.#buildRequest([]); // estimate without memory context
    if (this.#estimate(request) <= this.#budget) return undefined;

    if (!isCapable<CompactableCapable>(this.#host.memory, "compact")) {
      // No compaction available; drop oldest messages as crude fallback.
      const excess = this.#history.length - this.#keepTail;
      if (excess > 0) {
        this.#history.splice(0, excess);
        this.#host.logger.info("agent.compaction.fallback.sliced", {
          dropped: excess,
          kept: this.#keepTail,
        });
      }
      return undefined;
    }

    const keepTail = Math.min(this.#keepTail, this.#history.length);
    const head = this.#history.slice(0, this.#history.length - keepTail);
    if (head.length === 0) return undefined;

    const compactionInput: CompactionMessage[] = head.map(toCompactionMessage);
    try {
      const result = await this.#host.memory.compact({
        messages: compactionInput,
        keepTail,
        targetTokens: Math.max(1_000, Math.floor(this.#budget * 0.15)),
        sessionId: this.#session.id,
      });
      // Replace head with a synthetic assistant message summarizing it.
      const summaryMsg: LLMMessage = {
        role: "assistant",
        content: result.summary.content,
      };
      this.#history.splice(0, head.length, summaryMsg);
      return {
        type: "compaction",
        droppedCount: result.droppedCount,
        realtime: result.realtime ?? false,
      };
    } catch (err) {
      this.#host.logger.warn("agent.compaction.error", { err: String(err) });
      return undefined;
    }
  }

  #transitionTo(next: SessionState, reason?: string): void {
    const allowed = ALLOWED_TRANSITIONS[this.#session.state];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid session transition ${this.#session.state} → ${next}`);
    }
    this.#session.state = next;
    this.#session.updatedAt = Date.now();
    this.#host.logger.info(`session.${next}`, {
      sessionId: this.#session.id,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function extractText(blocks: readonly LLMContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toCompactionMessage(msg: LLMMessage): CompactionMessage {
  const role = msg.role === "tool" ? "tool" : (msg.role as "user" | "assistant");
  const content =
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .map((b) => {
            if (b.type === "text") return b.text;
            if (b.type === "thinking") return `[thinking] ${b.thinking}`;
            if (b.type === "tool_use") return `[tool_use ${b.name}] ${JSON.stringify(b.input)}`;
            if (b.type === "tool_result") return `[tool_result] ${b.content}`;
            return `[${b.type}]`;
          })
          .join("\n");
  return { role, content };
}

/**
 * Apply an in-progress content_block_delta to the accumulating block at
 * `index`. Mutates `blocks` in place.
 */
function applyDelta(
  blocks: LLMContentBlock[],
  index: number,
  delta: { type: string; [k: string]: unknown },
): void {
  const existing = blocks[index];
  if (!existing) return;
  if (delta.type === "text_delta" && existing.type === "text") {
    blocks[index] = { ...existing, text: existing.text + String(delta["text"] ?? "") };
  } else if (delta.type === "thinking_delta" && existing.type === "thinking") {
    blocks[index] = {
      ...existing,
      thinking: existing.thinking + String(delta["thinking"] ?? ""),
    };
  }
  // input_json_delta for tool_use blocks: accumulate as raw string — caller
  // finalizes JSON.parse on content_block_stop. We keep it simple: the
  // provider adapter is responsible for assembling final tool_use.input.
}

/** Rough default: 4 characters per token. Host should inject a provider-
 *  accurate tokenizer when available. */
function defaultEstimate(req: LLMRequest): number {
  let chars = 0;
  if (typeof req.system === "string") chars += req.system.length;
  else if (Array.isArray(req.system))
    chars += req.system.reduce(
      (sum, b) => sum + (b.type === "text" ? b.text.length : 0),
      0,
    );
  for (const m of req.messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      chars += m.content.reduce(
        (sum, b) => sum + (b.type === "text" ? b.text.length : 0),
        0,
      );
  }
  return Math.ceil(chars / 4);
}

function randomSessionId(): string {
  try {
    const g: { crypto?: { randomUUID?: () => string } } = globalThis;
    const uuid = g.crypto?.randomUUID?.();
    if (uuid) return `sess-${uuid}`;
  } catch {}
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
