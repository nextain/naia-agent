import type { ChatMessage } from "../domain/chat.js";
import type { ConversationPort } from "../ports/uc1.js";

/**
 * Budgeted conversation assembly — the real `ConversationPort` (replaces the
 * passthrough that the composition root used as a porting placeholder).
 *
 * Keeps the system prompt and the most-recent messages within a token budget and
 * drops the oldest, so long conversations don't overflow the provider's context
 * window (this is the agent's turn-level compaction). Token count is estimated by
 * character length (≈4 chars/token) to avoid a tokenizer dependency.
 *
 * Correctness guards:
 * - The newest message is always kept (a turn must have at least its latest input).
 * - The system prompt is preserved as-is (it's budgeted but never dropped).
 * - The kept window never *starts* with an orphaned `tool` result (its assistant
 *   tool-call round was trimmed away) — providers reject that.
 */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 6000;
const PER_MESSAGE_OVERHEAD_CHARS = 16; // role markers / framing per message

export function makeBudgetedConversation(opts?: { maxTokens?: number }): ConversationPort {
  const maxChars = Math.max(1, (opts?.maxTokens ?? DEFAULT_MAX_TOKENS)) * CHARS_PER_TOKEN;
  return {
    assemble: ({ messages, systemPrompt }) => {
      let budget = maxChars - (systemPrompt?.length ?? 0);
      const kept: ChatMessage[] = [];
      // Walk newest → oldest; keep while the budget allows, but always keep ≥1.
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        const cost = (m.content?.length ?? 0) + PER_MESSAGE_OVERHEAD_CHARS;
        if (kept.length > 0 && budget - cost < 0) break;
        budget -= cost;
        kept.unshift(m);
      }
      // Drop a leading orphaned tool result (its assistant round was trimmed).
      while (kept.length > 1 && kept[0]!.role === "tool") kept.shift();
      return { messages: kept, ...(systemPrompt !== undefined ? { systemPrompt } : {}) };
    },
  };
}
