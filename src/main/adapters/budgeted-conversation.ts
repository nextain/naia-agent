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
 * conservatively for CJK, other non-ASCII, code-like symbols and images, and at
 * ≈4 chars/token for plain ASCII text, without a tokenizer.
 *
 * Correctness guards:
 * - **Tool rounds are atomic.** An `assistant` message carrying `toolCalls` plus
 *   the `tool` result messages that follow it form one indivisible block, so the
 *   window can never keep a `tool` result without its originating assistant
 *   call (or an assistant call without its results) — both make providers reject.
 * - The newest block is always kept whole (a turn must carry at least its latest
 *   exchange), even if that single block exceeds the budget.
 * - The system prompt is preserved as-is (it's budgeted but never dropped). NOTE:
 *   if the system prompt alone exceeds the budget it is still sent; compression is
 *   a separate concern.
 * - The `toolCalls` payload (id/name/args, which can be large) is counted toward
 *   the budget, not just message text.
 * - A leading orphaned `tool` result (only possible from malformed input) is
 *   stripped so the window never *starts* with one.
 */
const CHARS_PER_TOKEN = 4;
/** CJK text costs far more than the English 4 chars/token heuristic. Measured on
 * the Qwen3 tokenizer (2026-11-09): 1,640 Hangul in mixed Korean prose → 1,680
 * tokens, ≈1.02 tokens per Hangul. Reserve 1.5 per code point for margin across
 * models. This is a conservative estimate, not a model tokenizer guarantee. */
const CJK_TOKENS_PER_CHAR = 1.5;
/** Other non-ASCII (emoji, CJK punctuation, full-width and other symbols) is
 * usually one or more tokens per UTF-16 unit, not a quarter. */
const OTHER_NON_ASCII_TOKENS_PER_UNIT = 1;
/** ASCII punctuation and digits (code, JSON) split into ≈2 chars/token, not 4. */
const ASCII_SYMBOL_TOKENS_PER_CHAR = 0.5;
/** Providers tokenize images by pixels, not by base64 length. A fixed reserve
 * per image covers a high-detail image on common vision models. */
const INLINE_IMAGE_TOKENS = 1600;
const CJK_RE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Yi}]/u;
export function estimateConversationTokens(text: string): number {
  let cjk = 0, otherNonAscii = 0, asciiSymbols = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) {
      if (/[^A-Za-z\s]/.test(ch)) asciiSymbols++;
    } else if (CJK_RE.test(ch)) {
      cjk += ch.length;
    } else {
      otherNonAscii += ch.length;
    }
  }
  const plainAscii = text.length - cjk - otherNonAscii - asciiSymbols;
  return cjk * CJK_TOKENS_PER_CHAR + otherNonAscii * OTHER_NON_ASCII_TOKENS_PER_UNIT +
    asciiSymbols * ASCII_SYMBOL_TOKENS_PER_CHAR + plainAscii / CHARS_PER_TOKEN;
}
const DEFAULT_MAX_TOKENS = 6000;
const PER_MESSAGE_OVERHEAD_CHARS = 16; // role markers / framing per message

export function conversationMessageCost(m: ChatMessage): number {
  let cost = estimateConversationTokens(m.content ?? "") + PER_MESSAGE_OVERHEAD_CHARS / CHARS_PER_TOKEN;
  if (m.reasoningContent) cost += estimateConversationTokens(m.reasoningContent);
  if (m.toolCalls?.length) cost += estimateConversationTokens(JSON.stringify(m.toolCalls)); // id/name/args payload
  if (m.toolCallId) cost += estimateConversationTokens(m.toolCallId);
  if (m.inlineImages?.length) cost += m.inlineImages.length * INLINE_IMAGE_TOKENS;
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
  const maxTokens = Math.max(0, opts?.maxTokens ?? DEFAULT_MAX_TOKENS);
  return {
    assemble: ({ messages, systemPrompt, maxTokens: requestedBudget }) => {
      const blocks = toBlocks(messages);
      const turnBudget = Number.isSafeInteger(requestedBudget) && requestedBudget! > 0 ? requestedBudget! : maxTokens;
      let budget = turnBudget - estimateConversationTokens(systemPrompt ?? "");
      // Keep the latest real user block and everything after it intact. Synthetic
      // user messages (tool-image carriers, retry/continuation instructions) belong
      // to the current turn and must not move its start past the real question.
      let requiredFrom = blocks.length - 1;
      for (let b = blocks.length - 1; b >= 0; b--) {
        if (blocks[b]!.some((m) => m.role === "user" && !m.synthetic)) { requiredFrom = b; break; }
      }
      const kept: ChatMessage[][] = [];
      // Walk newest → oldest; keep whole blocks while the budget allows, always ≥1.
      for (let b = blocks.length - 1; b >= 0; b--) {
        const block = blocks[b]!;
        const cost = block.reduce((sum, m) => sum + conversationMessageCost(m), 0);
        if (b < requiredFrom && budget - cost < 0) break;
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
