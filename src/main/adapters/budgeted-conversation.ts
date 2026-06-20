import type { ChatMessage } from "../domain/chat.js";
import type { ConversationPort } from "../ports/uc1.js";

/**
 * Budgeted conversation assembly — the real `ConversationPort` (replaces the
 * passthrough that the composition root used as a porting placeholder).
 *
 * Keeps the system prompt and the most-recent messages within a token budget and
 * drops the oldest, so long conversations don't overflow the provider's context
 * window. This is a DROP-ONLY token-budget guard, NOT information-preserving
 * compaction — the real summarizing compaction (rolling summary + light-model
 * recap + attachHandoff) lives in naia-memory's `compact()`; delegating to it is
 * tracked as a separate host-loop wiring task (agent#3). Token count is estimated
 * by character length (≈4 chars/token) to avoid a tokenizer dependency.
 *
 * Correctness guards:
 * - **Tool rounds are atomic.** An `assistant` message carrying `toolCalls` plus
 *   the `tool` result messages that follow it form one indivisible block, so the
 *   window can never keep a `tool` result without its originating assistant
 *   call (or an assistant call without its results) — both make providers reject.
 * - The newest block is always kept whole (a turn must carry at least its latest
 *   exchange), even if that single block exceeds the budget.
 * - The system prompt is preserved as-is (it's budgeted but never dropped). NOTE:
 *   if the system prompt alone exceeds the budget it is still sent — at the
 *   default budget (24k chars) that is not reachable; system-prompt compression is
 *   a separate concern.
 * - The `toolCalls` payload (id/name/args, which can be large) is counted toward
 *   the budget, not just message text.
 * - A leading orphaned `tool` result (only possible from malformed input) is
 *   stripped so the window never *starts* with one.
 */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 6000;
const PER_MESSAGE_OVERHEAD_CHARS = 16; // role markers / framing per message

function messageCost(m: ChatMessage): number {
  let cost = (m.content?.length ?? 0) + PER_MESSAGE_OVERHEAD_CHARS;
  if (m.toolCalls?.length) cost += JSON.stringify(m.toolCalls).length; // id/name/args payload
  if (m.toolCallId) cost += m.toolCallId.length;
  return cost;
}

/**
 * Group messages into atomic blocks. An `assistant` with `toolCalls` absorbs the
 * `tool` result messages immediately following it; every other message is its own
 * block. Keeping/dropping whole blocks is what preserves tool-round integrity.
 */
function toBlocks(messages: readonly ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const block: ChatMessage[] = [m];
      while (i + 1 < messages.length && messages[i + 1]!.role === "tool") {
        block.push(messages[++i]!);
      }
      blocks.push(block);
    } else {
      blocks.push([m]); // user / system / assistant(no tools) / orphan tool
    }
  }
  return blocks;
}

export function makeBudgetedConversation(opts?: { maxTokens?: number }): ConversationPort {
  const maxChars = Math.max(1, opts?.maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN;
  return {
    assemble: ({ messages, systemPrompt }) => {
      const blocks = toBlocks(messages);
      let budget = maxChars - (systemPrompt?.length ?? 0);
      const kept: ChatMessage[][] = [];
      // Walk newest → oldest; keep whole blocks while the budget allows, always ≥1.
      for (let b = blocks.length - 1; b >= 0; b--) {
        const block = blocks[b]!;
        const cost = block.reduce((sum, m) => sum + messageCost(m), 0);
        if (kept.length > 0 && budget - cost < 0) break;
        budget -= cost;
        kept.unshift(block);
      }
      const flat = kept.flat();
      // Strip a leading orphaned tool result (only from malformed input — blocks
      // keep assistant+tool together, so a kept block never starts with a tool).
      while (flat.length > 0 && flat[0]!.role === "tool") flat.shift();
      return { messages: flat, ...(systemPrompt !== undefined ? { systemPrompt } : {}) };
    },
  };
}
