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

import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.js";
import {
  SystemPromptBuilder,
} from "./system-prompt-builder.js";
import type {
  CompactableCapable,
  CompactionMessage,
  CompactionStrategy,
  HandoffBlob,
  HandoffCapable,
  HandoffTrigger,
  HostContext,
  LLMClient,
  LLMContentBlock,
  LLMMessage,
  LLMRequest,
  LLMStreamChunk,
  LLMUsage,
  MemoryHit,
  Session,
  SessionState,
  StopReason,
  ToolDefinition,
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolInvocation,
  TierLevel,
} from "@nextain/agent-types";
import { ALLOWED_TRANSITIONS, isCapable } from "@nextain/agent-types";

export interface AgentOptions {
  host: HostContext;
  /** Optional system prompt, inserted as top-level `system` field. */
  systemPrompt?: string;
  /**
   * Whether to append the built-in `DEFAULT_SYSTEM_PROMPT` behavioral
   * contract after the host's `systemPrompt`. Default `true` (unchanged
   * for all existing hosts). A host may set this `false` when it supplies
   * its own complete contract, runs under a tight token budget, or drives
   * a small model that the long contract degrades. General host-side
   * composition control — model/tier/profile-agnostic (the Agent has no
   * notion of tiers; profiles live in the host layer).
   *
   * Trade-off: opting out also removes the built-in Trust/Safety
   * behavioral rules in `DEFAULT_SYSTEM_PROMPT` — such a host must supply
   * equivalent guarantees itself.
   */
  appendDefaultSystemPrompt?: boolean;
  /** Override default model (otherwise provider default is used). */
  model?: string;
  /** Maximum tool-use iterations per `send()` call. Default 10. */
  maxToolHops?: number;
  /** After N consecutive tool calls return isError within one turn, the
   *  agent halts the turn and emits `tool.error.halt`. Default 3. */
  maxConsecutiveToolErrors?: number;
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
   * Handoff auto-trigger threshold — Slice 3-XR-Handoff (#50).
   * When the estimated request exceeds `contextBudget * handoffThreshold`
   * AND compaction has already run at least once this session, the agent
   * auto-fires `exportHandoff()` and emits a `handoff.exported` event.
   * Set to 0 to disable auto-trigger (manual export only). Default: 0.95.
   */
  handoffThreshold?: number;
  /**
   * Compaction strategy — Slice 3-XR-Compact (#47). Passed through to
   * memory.compact() as a hint and surfaced in the `compaction` event for
   * observability. Default: `reactive` (industry pattern, anchored iterative).
   *
   * - `reactive`: on-demand summarize at threshold (opencode/openclaw pattern).
   * - `realtime`: rolling summary via naia-memory v2 fast path.
   * - `anthropic-native`: server-side compaction (when backend = anthropic +
   *   Opus 4.6+). Agent does NOT call compact() — Anthropic handles it.
   * - `off`: agent never calls compact(). Conversation grows unbounded.
   */
  compactionStrategy?: CompactionStrategy;
  /**
   * Tier resolver — given a tool name, returns its tier. Host plugs in a
   * skill-spec lookup. Default: T1 (safe assumption).
   */
  tierForTool?: (name: string) => TierLevel;
}

/**
 * Events emitted by `sendStream()`. Callers pattern-match on `type`.
 *
 * **Channel duplication note**: `llm.chunk` carries the raw stream;
 * `text`/`thinking` events are **convenience derivatives** emitted by
 * Agent for the same underlying deltas. Subscribe to EITHER
 *   (a) `llm.chunk` for raw / low-level access, OR
 *   (b) `text` + `thinking` for pre-parsed progressive rendering.
 * Subscribing to both will double-render the same content.
 */
export type AgentStreamEvent =
  | { type: "session.started"; session: Readonly<Session> }
  | { type: "turn.started"; userText: string; recalled: number }
  | { type: "llm.chunk"; chunk: LLMStreamChunk }
  | {
      /** Derived from `text_delta` in llm.chunk. See channel-duplication note. */
      type: "thinking";
      text: string;
    }
  | {
      /** Derived from `text_delta` in llm.chunk. See channel-duplication note. */
      type: "text";
      text: string;
    }
  | { type: "tool.started"; invocation: ToolInvocation }
  | { type: "tool.ended"; invocation: ToolInvocation; result: ToolExecutionResult }
  | { type: "compaction"; droppedCount: number; realtime: boolean }
  | {
      /** Cross-session handoff blob produced — Slice 3-XR-Handoff (#50).
       *  Host should persist the blob (file or memory.attachHandoff) so the
       *  next session can import it. */
      type: "handoff.exported";
      trigger: HandoffTrigger;
      blob: HandoffBlob;
    }
  | { type: "usage"; usage: LLMUsage }
  | {
      /** Emitted when the agent stops because tool calls repeatedly returned
       *  errors. Inspect `lastResult` to surface to the user / logs. */
      type: "tool.error.halt";
      consecutiveErrors: number;
      lastInvocation: ToolInvocation;
      lastResult: ToolExecutionResult;
    }
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
  readonly #strategy: CompactionStrategy;
  /** Prior recap from the last compaction in this session. Anchored iterative
   *  summarization (Factory.ai) — the next compact() merges new head into this
   *  rather than re-summarizing from raw. Slice 3-XR-Compact (#47). */
  #priorRecap: CompactionMessage | undefined;
  /** Whether compaction has fired at least once this session. Gate for
   *  auto-handoff trigger (handoff only after compaction is exhausted).
   *  Slice 3-XR-Handoff (#50). */
  #compactedThisSession = false;
  /** Total turns processed (user messages). Used as `turnCount` in handoff
   *  blobs. Slice 3-XR-Handoff (#50). */
  #turnCount = 0;
  /** Auto-handoff threshold as a fraction of contextBudget (0..1, 0 = disable).
   *  Slice 3-XR-Handoff (#50). */
  readonly #handoffThreshold: number;
  /** Whether a handoff has been auto-fired this session (one-shot guard so
   *  budget-95 thrash doesn't emit duplicates). Slice 3-XR-Handoff (#50). */
  #handoffFired = false;
  /** Whether session.started has been emitted. One-shot guard so
   *  sendStream() does not re-emit on subsequent turns. */
  #sessionStartedEmitted = false;
  /** Anchors injected into the system prompt from an imported handoff blob.
   *  Prepended to system prompt at the start of the next turn. Slice 3-XR-Handoff (#50). */
  #importedHandoff: HandoffBlob | undefined;
  readonly #tierFor: (name: string) => TierLevel;
  readonly #maxConsecutiveToolErrors: number;
  readonly #appendDefaultSystem: boolean;

  constructor(options: AgentOptions) {
    this.#host = options.host;
    if (options.model !== undefined) this.#model = options.model;
    if (options.systemPrompt !== undefined) this.#system = options.systemPrompt;
    this.#appendDefaultSystem = options.appendDefaultSystemPrompt ?? true;
    this.#maxHops = options.maxToolHops ?? 10;
    this.#estimate = options.estimateTokens ?? defaultEstimate;
    this.#budget = options.contextBudget ?? 80_000;
    this.#keepTail = options.compactionKeepTail ?? 6;
    this.#strategy = options.compactionStrategy ?? "reactive";
    this.#handoffThreshold = options.handoffThreshold ?? 0.95;
    this.#tierFor = options.tierForTool ?? (() => "T1");
    this.#maxConsecutiveToolErrors = options.maxConsecutiveToolErrors ?? 3;

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

  clearHistory(): void {
    this.#history.length = 0;
    this.#priorRecap = undefined;
    this.#compactedThisSession = false;
    this.#turnCount = 0;
    this.#handoffFired = false;
  }

  replaceLlm(llm: LLMClient): void {
    (this.#host as { llm: LLMClient }).llm = llm;
  }

  /** Convenience: drain the stream and return the final assistant text. */
  async send(userText: string, signal?: AbortSignal): Promise<string> {
    const fn = this.#host.logger.fn?.("Agent.send", { userTextLen: userText.length });
    let finalText = "";
    for await (const ev of this.sendStream(userText, signal)) {
      if (ev.type === "turn.ended") finalText = ev.assistantText;
    }
    fn?.exit({ assistantTextLen: finalText.length });
    return finalText;
  }

  /** Async generator version for callers that want chunk-level control. */
  async #listTools(signal?: AbortSignal): Promise<ToolDefinitionWithTier[]> {
    if (!this.#host.tools.list) return [];
    try {
      return await this.#host.tools.list(signal);
    } catch (err) {
      this.#host.logger.warn("agent.tools.list.error", { err: String(err) });
      return [];
    }
  }

  /** Stream-first entry point. Yields structured events throughout the turn. */
  async *sendStream(
    userText: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    const fn = this.#host.logger.fn?.("Agent.sendStream", { userTextLen: userText.length, sessionState: this.#session.state });
    if (this.#session.state !== "active") {
      fn?.branch("session-not-active");
      throw new Error(`Cannot send — session is "${this.#session.state}"`);
    }

    if (!this.#sessionStartedEmitted) {
      this.#sessionStartedEmitted = true;
      yield { type: "session.started", session: this.#session };
    }

    // 1. Recall memory for context.
    const hits = await this.#recallMemory(userText);
    this.#history.push({ role: "user", content: userText });
    this.#turnCount++;
    fn?.branch("turn-started", { recalled: hits.length });
    yield { type: "turn.started", userText, recalled: hits.length };

    let hopsRemaining = this.#maxHops;
    let finalText = "";
    const aggUsage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    const tierByName = new Map<string, TierLevel>();
    let compactedThisTurn = false;
    let consecutiveToolErrors = 0;
    let lastBadInvocation: ToolInvocation | undefined;
    let halted = false;
    // LLM-initiated recall (#41 v2): a model emits a `<recall>query</recall>`
    // text marker instead of a native tool call. Model-agnostic. Depth-
    // guarded to prevent self-generated recall loops (cross-review B-loop).
    let recallHopsRemaining = 2;

    while (hopsRemaining-- > 0) {
      if (signal?.aborted) break;

      // 2. Refresh tool list per iteration (careti pattern — tool registry
      //    may change mid-loop when skills enable/disable).
      const toolDefs = await this.#listTools(signal);
      tierByName.clear();
      for (const t of toolDefs) tierByName.set(t.name, t.tier);

      // 3. Budget check → delegate compaction to memory if capable (once/turn).
      if (!compactedThisTurn) {
        const compactEvent = await this.#maybeCompact(hits, toolDefs);
        if (compactEvent) {
          compactedThisTurn = true;
          yield compactEvent;

          // 3b. Auto-handoff trigger — Slice 3-XR-Handoff (#50).
          // After compaction, if budget is STILL near limit, escalate to handoff.
          // Fires at most once per session (idempotent).
          const handoffEvent = await this.#maybeAutoHandoff(hits, toolDefs);
          if (handoffEvent) {
            yield handoffEvent;
          }
        }
      }

      // 4. Build + stream LLM request.
      const request = this.#buildRequest(hits, toolDefs);
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
        // LLM-initiated recall (#41 v2). If the model asked for memory
        // via a `<recall>query</recall>` marker, recall and re-generate.
        // Query sanitized (length-bounded, non-empty) per cross-review
        // B-query; depth-guarded per B-loop. Writes unaffected (read-only).
        const marker = finalText.match(/<recall>([\s\S]{1,256}?)<\/recall>/i);
        const recallQuery = marker?.[1]?.trim();
        if (recallQuery && recallQuery.length >= 2 && recallHopsRemaining-- > 0) {
          const more = await this.#recallMemory(recallQuery);
          for (const h of more) hits.push(h);
          this.#host.logger.fn?.("Agent.recallMarker")?.exit({
            query: recallQuery.slice(0, 64), hits: more.length,
            hopsLeft: recallHopsRemaining,
          });
          continue;
        }
        // No actionable marker (or budget exhausted): sanitize residue so
        // users never see raw tags — well-formed AND small-model malformed
        // variants. OUTPUT hygiene only; the agent still ACTS solely on the
        // strict form above (#41 v2 — leniency must not reach recall).
        finalText = stripRecallResidue(finalText);
        break;
      }

      // 5. Tool-hop: execute each tool_use, push tool_result turn.
      const toolResults: LLMContentBlock[] = [];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        if (signal?.aborted) break;
        const invocation: ToolInvocation = {
          id: block.id,
          name: block.name,
          input: block.input,
          tier: tierByName.get(block.name) ?? this.#tierFor(block.name),
          sessionId: this.#session.id,
        };
        yield { type: "tool.started", invocation };
        const result = await this.#executeTool(invocation, signal);
        yield { type: "tool.ended", invocation, result };
        if (result.isError === true) {
          consecutiveToolErrors++;
          lastBadInvocation = invocation;
        } else {
          consecutiveToolErrors = 0;
        }
        toolResults.push({
          type: "tool_result",
          toolCallId: block.id,
          content: result.content,
          ...(result.isError === true ? { isError: true } : {}),
        });
        if (consecutiveToolErrors >= this.#maxConsecutiveToolErrors) {
          yield {
            type: "tool.error.halt",
            consecutiveErrors: consecutiveToolErrors,
            lastInvocation: invocation,
            lastResult: result,
          };
          halted = true;
          break;
        }
      }
      this.#history.push({ role: "tool", content: toolResults });
      if (halted) {
        finalText = `[agent halted — ${consecutiveToolErrors} consecutive tool errors on "${lastBadInvocation?.name}"]`;
        break;
      }
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
    // Skip memory encoding when halted — the halt marker is noise that
    // would pollute future recalls. Surface the halt through the event
    // stream only.
    if (!halted) {
      await this.#encodeTurn(userText, finalText);
    }
    yield { type: "turn.ended", assistantText: finalText };
  }

  /**
   * End the session. Further `send()` calls throw.
   * Host owns `memory.close()` — multiple Agents may share one HostContext
   * so Agent MUST NOT close the shared memory here.
   */
  close(): void {
    if (this.#session.state === "closed" || this.#session.state === "failed") return;
    this.#transitionTo("closed");
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

  #buildRequest(
    memoryHits: MemoryHit[],
    toolDefs: readonly ToolDefinitionWithTier[] = [],
    consumeTransient = true,
  ): LLMRequest {
    const builder = new SystemPromptBuilder();

    if (this.#system) {
      builder.add({
        source: "host",
        priority: 100,
        section: "identity",
        content: this.#system,
      });
    }

    if (this.#appendDefaultSystem) {
      builder.add({
        source: "core",
        priority: 200,
        section: "safety",
        content: DEFAULT_SYSTEM_PROMPT,
      });
    }

    if (this.#importedHandoff) {
      const h = this.#importedHandoff;
      const lines = [
        `Prior session recap (${h.turnCount} turns, exported ${new Date(h.createdAt).toISOString()}):`,
        h.recap.content,
      ];
      if (h.anchors.length > 0) {
        lines.push(`Known identifiers from prior session: ${h.anchors.join(", ")}`);
      }
      builder.add({
        source: "core",
        priority: 300,
        section: "handoff",
        content: lines.join("\n\n"),
      });
      if (consumeTransient) this.#importedHandoff = undefined;
    }

    if (memoryHits.length > 0) {
      const recalled = memoryHits.map((h) => `- ${h.content}`).join("\n");
      builder.add({
        source: "core",
        priority: 400,
        section: "memory",
        content: `Relevant context from memory:\n${recalled}`,
      });
    }

    const req: LLMRequest = { messages: this.#history };
    if (this.#model !== undefined) req.model = this.#model;
    const system = builder.build();
    if (system.length > 0) req.system = system;
    if (toolDefs.length > 0) {
      req.tools = toolDefs.map<ToolDefinition>((t) => {
        const def: ToolDefinition = { name: t.name, inputSchema: t.inputSchema };
        if (t.description !== undefined) def.description = t.description;
        return def;
      });
    }
    return req;
  }

  /**
   * Streaming helper — consumes `llm.stream()`, forwards chunks as
   * AgentStreamEvents, accumulates final block/stopReason/usage.
   *
   * Tool-use `input` is assembled from `input_json_delta` partials, parsed
   * on `content_block_stop`. Text/thinking blocks accumulate their deltas
   * across chunks.
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
    /** Accumulator for tool_use input_json_delta partials, keyed by block index. */
    const toolInputBuffer = new Map<number, string>();
    let stopReason: StopReason = "end_turn";
    const usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    const reqWithSignal: LLMRequest = { ...request };
    if (signal) reqWithSignal.signal = signal;

    for await (const chunk of this.#host.llm.stream(reqWithSignal)) {
      yield { type: "llm.chunk", chunk };
      if (chunk.type === "content_block_start") {
        blocks[chunk.index] = chunk.block;
        // tool_use SDK-starts with empty/partial input; we'll rebuild on stop.
        if (chunk.block.type === "tool_use") {
          toolInputBuffer.set(chunk.index, "");
        }
      } else if (chunk.type === "content_block_delta") {
        applyDelta(blocks, chunk.index, chunk.delta, toolInputBuffer);
        // Surface progressive text / thinking as discrete events so hosts
        // don't have to re-parse llm.chunk.
        if (chunk.delta.type === "text_delta") {
          yield { type: "text", text: String(chunk.delta.text) };
        } else if (chunk.delta.type === "thinking_delta") {
          yield { type: "thinking", text: String(chunk.delta.thinking) };
        }
      } else if (chunk.type === "content_block_stop") {
        // Finalize tool_use input from accumulated JSON.
        const raw = toolInputBuffer.get(chunk.index);
        if (raw !== undefined) {
          const block = blocks[chunk.index];
          if (block?.type === "tool_use") {
            try {
              blocks[chunk.index] = { ...block, input: JSON.parse(raw || "{}") };
            } catch {
              this.#host.logger.warn("agent.tool_use.input_parse.error", {
                index: chunk.index,
                raw,
              });
              blocks[chunk.index] = { ...block, input: {} };
            }
          }
          toolInputBuffer.delete(chunk.index);
        }
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
    return {
      blocks: blocks.filter((b): b is LLMContentBlock => b !== undefined),
      stopReason,
      usage,
    };
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
   *
   * The cut point is always a **turn boundary** (between user messages).
   * This prevents `tool_use` / `tool_result` orphaning (opencode pattern).
   * Passing `memoryHits` and `toolDefs` lets us estimate the full request
   * (not just the bare history), matching the actual LLM call size.
   */
  async #maybeCompact(
    memoryHits: MemoryHit[],
    toolDefs: readonly ToolDefinitionWithTier[],
  ): Promise<AgentStreamEvent | undefined> {
    // Strategy gates — short-circuit when the host explicitly disabled
    // host-side compaction (Slice 3-XR-Compact #47 §6).
    if (this.#strategy === "off") {
      const request = this.#buildRequest(memoryHits, toolDefs, false);
      if (this.#estimate(request) > this.#budget) {
        const cutAt = findTurnCutPoint(this.#history, this.#keepTail);
        if (cutAt > 0) {
          this.#history.splice(0, cutAt);
          this.#host.logger.info("agent.history.hard-trim", {
            reason: "strategy-off-budget-exceeded",
            dropped: cutAt,
          });
        }
      }
      return undefined;
    }
    if (this.#strategy === "anthropic-native") {
      // Server-side compaction is the authoritative path; we MUST NOT also
      // mutate history client-side or we double-compact. The provider adapter
      // surfaces compaction events separately when the API reports them.
      return undefined;
    }

    const request = this.#buildRequest(memoryHits, toolDefs, false);

    // Find turn boundary — keep last N user messages verbatim.
    const cutAt = findTurnCutPoint(this.#history, this.#keepTail);
    if (cutAt <= 0) return undefined;
    const head = this.#history.slice(0, cutAt);
    const keptTail = this.#history.length - cutAt;

    if (!isCapable<CompactableCapable>(this.#host.memory, "compact")) {
      // No compaction available; drop head as crude fallback.
      this.#history.splice(0, cutAt);
      this.#host.logger.info("agent.compaction.fallback.sliced", {
        dropped: cutAt,
        kept: keptTail,
      });
      return undefined;
    }

    const compactionInput: CompactionMessage[] = head.map(toCompactionMessage);
    try {
      const result = await this.#host.memory.compact({
        messages: compactionInput,
        keepTail: keptTail,
        targetTokens: Math.max(1_000, Math.floor(this.#budget * 0.15)),
        sessionId: this.#session.id,
        strategy: this.#strategy,
        ...(this.#priorRecap !== undefined ? { priorRecap: this.#priorRecap } : {}),
      });
      // Replace the head window with a synthetic assistant message.
      // `droppedCount` is an advisory from memory; we honour our own cutAt
      // as the source of truth to keep history.length predictable.
      const summaryMsg: LLMMessage = {
        role: "assistant",
        content: result.summary.content,
      };
      this.#history.splice(0, cutAt, summaryMsg);
      // Anchored iterative — store this recap as the seed for the next
      // compaction in the same session. Slice 3-XR-Compact (#47) §6.
      this.#priorRecap = result.summary;
      this.#compactedThisSession = true;
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

  /**
   * Auto-trigger check — Slice 3-XR-Handoff (#50).
   *
   * Fires AFTER a compaction attempt. If the request estimate STILL exceeds
   * `contextBudget * handoffThreshold` (default 95%) even after compaction,
   * escalate to a handoff export. Idempotent within a session: only fires
   * once per session (`#handoffFired` guard) to avoid budget-thrash spam.
   *
   * Trigger gate: `handoffThreshold > 0` AND `#compactedThisSession === true`
   * AND `#handoffFired === false` AND `estimate > budget * threshold`.
   */
  async #maybeAutoHandoff(
    memoryHits: MemoryHit[],
    toolDefs: readonly ToolDefinitionWithTier[],
  ): Promise<AgentStreamEvent | undefined> {
    if (this.#handoffThreshold <= 0) return undefined;
    if (!this.#compactedThisSession) return undefined;
    if (this.#handoffFired) return undefined;

    const request = this.#buildRequest(memoryHits, toolDefs, false);
    if (this.#estimate(request) <= this.#budget * this.#handoffThreshold) {
      return undefined;
    }

    try {
      const blob = await this.exportHandoff("budget-95-post-compact");
      this.#handoffFired = true;
      return { type: "handoff.exported", trigger: blob.trigger, blob };
    } catch (err) {
      this.#host.logger.warn("agent.handoff.error", { err: String(err) });
      return undefined;
    }
  }

  /**
   * Export the current session as a HandoffBlob — Slice 3-XR-Handoff (#50).
   *
   * Calls `memory.compact({keepTail: 0})` on the full history so the recap
   * covers EVERYTHING (not just the head). Extracts identifier anchors
   * (UUID / URL / file paths) from the recap content for fact-level recall
   * in the next session.
   *
   * Synchronous API for hosts that want to explicitly persist the blob
   * (file mode). The auto-trigger path additionally emits a
   * `handoff.exported` event for fire-and-forget hosts.
   */
  async exportHandoff(
    trigger: HandoffTrigger = "manual",
  ): Promise<HandoffBlob> {
    const messages = this.#history.map(toCompactionMessage);
    const totalChars = messages.reduce(
      (acc, m) => acc + m.content.length,
      0,
    );

    let recapContent = `[Session ${this.#session.id} — ${messages.length} messages exported]`;
    if (isCapable<CompactableCapable>(this.#host.memory, "compact")) {
      try {
        const result = await this.#host.memory.compact({
          messages,
          keepTail: 0,
          targetTokens: Math.max(2_000, Math.floor(this.#budget * 0.5)),
          sessionId: this.#session.id,
          strategy: this.#strategy,
          ...(this.#priorRecap !== undefined ? { priorRecap: this.#priorRecap } : {}),
        });
        recapContent = result.summary.content;
      } catch (err) {
        this.#host.logger.warn("agent.handoff.compact.error", {
          err: String(err),
        });
      }
    }

    const anchors = extractAnchors(recapContent, this.#history);

    return {
      version: 1,
      sessionId: this.#session.id,
      createdAt: Date.now(),
      turnCount: this.#turnCount,
      totalTokens: Math.floor(totalChars / 4),
      trigger,
      recap: { role: "assistant", content: recapContent, timestamp: Date.now() },
      anchors,
    };
  }

  /**
   * Import a HandoffBlob — the recap + anchors will be injected into the
   * system prompt at the start of the next turn. Slice 3-XR-Handoff (#50).
   *
   * The import is one-shot: once a turn has used the imported handoff,
   * `#importedHandoff` is cleared so subsequent turns rely on normal
   * recall + history.
   *
   * If the host's memory implements `HandoffCapable.attachHandoff`, the blob
   * is ALSO attached to the long-term store so recall picks it up across
   * future sessions.
   */
  async importHandoff(blob: HandoffBlob): Promise<void> {
    this.#importedHandoff = blob;
    if (isCapable<HandoffCapable>(this.#host.memory, "attachHandoff")) {
      try {
        await this.#host.memory.attachHandoff(blob);
      } catch (err) {
        this.#host.logger.warn("agent.handoff.attach.error", {
          err: String(err),
        });
      }
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

/**
 * Extract strict-preserved identifier anchors from a recap + raw history —
 * Slice 3-XR-Handoff (#50). File paths (extension-bearing), URLs, and
 * uppercase-snake-case identifiers (e.g. order numbers `#A-7421`).
 * Deduped, capped at 32. Used by handoff blobs for fact-level recall.
 */
function extractAnchors(
  recap: string,
  history: readonly LLMMessage[],
): readonly string[] {
  const combined =
    recap + "\n" + history.map((m) => extractText(toContentBlocks(m))).join("\n");
  const out = new Set<string>();
  const pathRe = /(?:^|\s|`)([\/\w][\w./\-]*\.[a-z]{1,6})(?=\s|`|$|[,.;:!?])/gim;
  const urlRe = /https?:\/\/[^\s)`'"<>]+/g;
  const idRe = /#[A-Z][A-Z0-9_-]{2,}/g;
  for (const m of combined.matchAll(pathRe)) {
    const p = m[1];
    if (p && p.length >= 3) out.add(p);
    if (out.size >= 32) break;
  }
  for (const m of combined.matchAll(urlRe)) {
    out.add(m[0]);
    if (out.size >= 32) break;
  }
  for (const m of combined.matchAll(idRe)) {
    out.add(m[0]);
    if (out.size >= 32) break;
  }
  return [...out];
}

/** Adapt LLMMessage.content (string | block[]) to block[] for extractText. */
function toContentBlocks(msg: LLMMessage): readonly LLMContentBlock[] {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  return msg.content;
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
 * `index`. Mutates `blocks` and `toolInputBuffer` in place.
 */
function applyDelta(
  blocks: LLMContentBlock[],
  index: number,
  delta: { type: string; [k: string]: unknown },
  toolInputBuffer: Map<number, string>,
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
  } else if (delta.type === "input_json_delta" && existing.type === "tool_use") {
    const prev = toolInputBuffer.get(index) ?? "";
    toolInputBuffer.set(index, prev + String(delta["partialJson"] ?? ""));
  }
}

/**
 * Return the index at which to cut `history` so that the last `keepTurns`
 * user messages (and every assistant/tool message after them) stay intact.
 * Returns 0 if the history has ≤ keepTurns user messages.
 */
function findTurnCutPoint(history: readonly LLMMessage[], keepTurns: number): number {
  let userSeen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") {
      userSeen++;
      if (userSeen >= keepTurns) return i;
    }
  }
  return 0;
}

/** Rough default: 4 characters per token. Host should inject a provider-
 *  accurate tokenizer when available. */
function defaultEstimate(req: LLMRequest): number {
  let asciiChars = 0;
  let cjkChars = 0;
  const countBlock = (text: string) => {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x3040 && cp <= 0x309f) ||
        (cp >= 0x30a0 && cp <= 0x30ff) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0x1100 && cp <= 0x11ff) ||
        (cp >= 0x3130 && cp <= 0x318f)
      ) {
        cjkChars++;
      } else {
        asciiChars++;
      }
    }
  };
  if (typeof req.system === "string") countBlock(req.system);
  else if (Array.isArray(req.system))
    for (const b of req.system)
      if (b.type === "text") countBlock(b.text);
  for (const m of req.messages) {
    if (typeof m.content === "string") countBlock(m.content);
    else
      for (const b of m.content)
        if (b.type === "text") countBlock(b.text);
  }
  return Math.ceil(asciiChars / 4 + cjkChars * 1.5);
}

function randomSessionId(): string {
  try {
    const g: { crypto?: { randomUUID?: () => string } } = globalThis;
    const uuid = g.crypto?.randomUUID?.();
    if (uuid) return `sess-${uuid}`;
  } catch {}
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Display hygiene for the final answer: remove small-model `<recall>`
 * marker residue (well-formed AND malformed: `<recalall>…</recalall>`,
 * `<recal_l>…</recal_l>`, `<recal_…</recal>`, `<recal<…</recal>`, stray
 * `</recall>`, unterminated trailing `<recal_…`). OUTPUT-ONLY: the agent
 * still ACTS solely on the strict `<recall>q</recall>` form (#41 v2) —
 * this leniency must never influence whether a recall fires (cross-review
 * invariant A), only what the user sees.
 *
 * Cross-review #2 BLOCK fixes:
 *  - Anchor to the `recal` family ONLY (`recal[la]*`): `<recap>`,
 *    `<recapitulate>`, `<recital>`, `<receipt>` never match.
 *  - Strip ONLY a line-leading/standalone marker (the small-model failure
 *    mode) — a `<recall>` quoted mid-prose or in a code span is preserved
 *    (the agent must not erase its own protocol documentation).
 *  - Content bounded to {0,256} (mirrors the strict matcher) so a marker
 *    cannot bridge real paragraphs; trailing-open bounded to 64.
 *  - Marker-free input is returned BYTE-IDENTICAL (no whitespace/​trim
 *    mangling of normal answers or code); trim only when residue removed.
 *  - Nullish-safe. Pure + exported for unit tests.
 */
export function stripRecallResidue(text: string): string {
  if (!text) return text ?? "";
  const W = String.raw`recal[la]*`; // recal | recall | recalll | recalall
  const LEAD = String.raw`(^|\n)[ \t]*`; // line-leading only
  const out = text
    // line-leading marker PAIR (content bounded — no paragraph bridging)
    .replace(
      new RegExp(`${LEAD}<\\s*${W}[\\s\\S]{0,256}?<\\s*/\\s*${W}[^>]{0,8}>`, "gi"),
      "$1",
    )
    // line-leading unpaired marker-ish tag (bounded)
    .replace(new RegExp(`${LEAD}<\\s*/?\\s*${W}[^>]{0,16}>`, "gi"), "$1")
    // line-leading unterminated open at end (bounded, single-line)
    .replace(new RegExp(`${LEAD}<\\s*/?\\s*${W}[^>\\n]{0,64}$`, "i"), "$1");
  // Only normalize edges when residue was actually removed — a marker-free
  // answer (incl. code/whitespace) is returned untouched.
  return out === text ? text : out.replace(/^\s+|\s+$/g, "");
}
