/**
 * pi-mono compaction algorithm — TS port for naia-agent (Slice 3-XR-Compact v2 #56 R8).
 *
 * Source: https://github.com/earendil-works/pi-mono
 *   - `packages/agent/src/harness/compaction/compaction.ts`
 *   - License: MIT, (c) 2025 Mario Zechner
 *
 * Why ported (not imported): pi-mono types (SessionTreeEntry, AgentMessage) bind
 * the algorithm to pi's session tree; we operate on naia-agent's `LLMMessage[]`.
 * Re-implementing the 5-step anchored-iterative compaction lets us own the
 * adapter and evolve independently. License header above preserves attribution.
 *
 * Algorithm (pi compaction.md §"How It Works"):
 *   1. Estimate tokens per message (char/4 heuristic).
 *   2. Walk backward from newest message, accumulate tokens until
 *      `keepRecentTokens` reached → cut point.
 *   3. Slice [0..cut) = messagesToSummarize; [cut..] = keptMessages.
 *   4. LLM call: SUMMARIZATION_SYSTEM_PROMPT + conversation + (previous summary
 *      as <previous-summary> if iterative) + SUMMARIZATION_PROMPT.
 *   5. Return [summary-as-system-message, ...keptMessages]. Store summary for
 *      next iteration (anchored iterative).
 *
 * The exact prompt texts are copied verbatim from pi (MIT license permits this
 * with attribution; see header).
 */

import type { LLMClient } from "@nextain/agent-core";
import type { LLMMessage } from "@nextain/agent-types";

// ─── License-preserved prompts (MIT, pi-mono Mario Zechner 2025) ──────────────

/** pi's `SUMMARIZATION_SYSTEM_PROMPT` (compaction.ts:378). */
export const PI_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** pi's `SUMMARIZATION_PROMPT` (compaction.ts:382). First-time compaction. */
export const PI_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** pi's `UPDATE_SUMMARIZATION_PROMPT` (compaction.ts:415). Iterative compaction. */
export const PI_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// ─── Token estimation (pi compaction.ts:202 estimateTokens) ────────────────────

/** Conservative char-based token estimate (pi: ceil(chars/4)). */
export function estimateMessageTokens(msg: LLMMessage): number {
	let chars = 0;
	if (typeof msg.content === "string") {
		chars = msg.content.length;
	} else {
		for (const block of msg.content) {
			if (block.type === "text") chars += block.text.length;
			else if (block.type === "thinking") chars += block.thinking.length;
			else if (block.type === "redacted_thinking") chars += block.data.length;
			else if (block.type === "tool_use") {
				chars += block.name.length + JSON.stringify(block.input).length;
			} else if (block.type === "tool_result") {
				chars += block.content.length;
			} else if (block.type === "image") {
				chars += 4800; // pi's per-image budget
			}
		}
	}
	return Math.ceil(chars / 4);
}

// ─── Cut-point selection (pi compaction.ts:328 findCutPoint) ───────────────────

export interface PiCutPointResult {
	readonly cutIndex: number;
	readonly tokensInKept: number;
	readonly tokensInSummarize: number;
}

/**
 * Walk backward from the newest message, accumulating tokens until
 * `keepRecentTokens` reached. The cut index is the boundary where
 * [0..cutIndex) gets summarized and [cutIndex..] is kept verbatim.
 *
 * Differs from pi's exact implementation in one way: we operate on a flat
 * LLMMessage[] (no SessionTreeEntry with role-specific cut rules). The
 * boundary is at any message; pi additionally prefers turn boundaries
 * (user-message start). For naia-agent's purpose (compaction at budget
 * threshold), message-level boundary is acceptable.
 */
export function findCutPoint(
	history: readonly LLMMessage[],
	keepRecentTokens: number,
): PiCutPointResult {
	if (history.length === 0) {
		return { cutIndex: 0, tokensInKept: 0, tokensInSummarize: 0 };
	}
	let accumulatedTokens = 0;
	let cutIndex = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (msg === undefined) continue;
		const msgTokens = estimateMessageTokens(msg);
		accumulatedTokens += msgTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			// Prefer cutting at a user message boundary (turn-start) so the
			// kept tail begins coherently. Walk forward until we find one.
			cutIndex = i;
			for (let j = i; j < history.length; j++) {
				if (history[j]?.role === "user") {
					cutIndex = j;
					break;
				}
			}
			break;
		}
	}
	// Compute remaining token counts.
	let tokensInSummarize = 0;
	for (let i = 0; i < cutIndex; i++) {
		const msg = history[i];
		if (msg !== undefined) tokensInSummarize += estimateMessageTokens(msg);
	}
	let tokensInKept = 0;
	for (let i = cutIndex; i < history.length; i++) {
		const msg = history[i];
		if (msg !== undefined) tokensInKept += estimateMessageTokens(msg);
	}
	return { cutIndex, tokensInKept, tokensInSummarize };
}

// ─── Conversation serialization (pi utils.ts serializeConversation) ────────────

function llmMessageToPlainText(msg: LLMMessage): string {
	if (typeof msg.content === "string") return msg.content;
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "thinking") parts.push(`[thinking]\n${block.thinking}`);
		else if (block.type === "tool_use") {
			parts.push(`[tool_use ${block.name}]\n${JSON.stringify(block.input)}`);
		} else if (block.type === "tool_result") {
			parts.push(`[tool_result]\n${block.content}`);
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}

function serializeConversation(history: readonly LLMMessage[]): string {
	const lines: string[] = [];
	for (const msg of history) {
		const text = llmMessageToPlainText(msg);
		lines.push(`${msg.role}: ${text}`);
	}
	return lines.join("\n\n");
}

// ─── Adapter — factory returning a `prepareCompact` hook ───────────────────────

export interface PiCompactionOptions {
	/** LLM client used to generate the summary. Required. */
	readonly llm: LLMClient;
	/** Approximate tokens to keep in the recent tail (pi default 20_000). */
	readonly keepRecentTokens?: number;
	/** Custom focus instruction (pi's `/compact <focus>` analogue). Optional. */
	readonly focusTopic?: string;
	/** Max tokens for the summary LLM call (pi: 0.8 × reserveTokens, default ~13k). */
	readonly maxSummaryTokens?: number;
	/** Optional logger for compaction events. */
	readonly logger?: {
		readonly info?: (msg: string, meta?: Record<string, unknown>) => void;
		readonly warn?: (msg: string, meta?: Record<string, unknown>) => void;
	};
}

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_MAX_SUMMARY_TOKENS = 13_000;

/**
 * Create a naia-agent-compatible `prepareCompact` hook that runs pi-mono's
 * anchored-iterative LLM compaction. Each invocation calls the LLM once;
 * the previous summary is threaded via closure for the iterative pattern.
 *
 * Usage:
 *   const prepareCompact = createPiLLMMessagePrepareCompact({
 *     llm: hostLLMClient,
 *     keepRecentTokens: 20_000,
 *   });
 *   new Agent({ ..., prepareCompact });
 *
 * Returns `undefined` (no-op) when:
 *   - history is empty
 *   - cut point would leave nothing to summarize (history smaller than keep tail)
 *   - LLM call fails (caller logs + skips compaction this turn)
 */
export function createPiLLMMessagePrepareCompact(
	options: PiCompactionOptions,
): (history: readonly LLMMessage[]) => Promise<LLMMessage[] | undefined> {
	const keepRecentTokens = options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	const maxSummaryTokens = options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
	const logger = options.logger;

	// Anchored-iterative state. Persists across calls in this closure;
	// caller creates a new factory per session/agent to reset.
	let previousSummary: string | undefined;

	return async (history) => {
		if (history.length === 0) return undefined;

		const cut = findCutPoint(history, keepRecentTokens);
		if (cut.cutIndex === 0) {
			// Nothing older than keep-tail; no compaction possible.
			logger?.info?.("pi.compaction.skip.nothing-to-summarize", {
				historyLen: history.length,
				keepRecentTokens,
				tokensInKept: cut.tokensInKept,
			});
			return undefined;
		}

		const messagesToSummarize = history.slice(0, cut.cutIndex);
		const keptMessages = history.slice(cut.cutIndex);
		const conversationText = serializeConversation(messagesToSummarize);

		// Build the user-message prompt: conversation + (previous summary?) +
		// instruction. The system prompt is fixed.
		const basePromptText = previousSummary
			? PI_UPDATE_SUMMARIZATION_PROMPT
			: PI_SUMMARIZATION_PROMPT;
		const focusSuffix = options.focusTopic
			? `\n\nAdditional focus: ${options.focusTopic}`
			: "";
		const userPrompt = previousSummary
			? `<conversation>\n${conversationText}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${basePromptText}${focusSuffix}`
			: `<conversation>\n${conversationText}\n</conversation>\n\n${basePromptText}${focusSuffix}`;

		let summaryText: string;
		try {
			summaryText = await callLLMForSummary(
				options.llm,
				PI_SUMMARIZATION_SYSTEM_PROMPT,
				userPrompt,
				maxSummaryTokens,
			);
		} catch (err) {
			logger?.warn?.("pi.compaction.llm.error", {
				err: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}

		if (!summaryText || summaryText.trim().length === 0) {
			logger?.warn?.("pi.compaction.empty-summary", {
				historyLen: history.length,
				cutIndex: cut.cutIndex,
			});
			return undefined;
		}

		// Update anchored-iterative state for the next call.
		previousSummary = summaryText.trim();

		// Replace [0..cutIndex) with a single user message holding the summary.
		// LLMRole has no "system" — system prompts go in LLMRequest.system.
		// Using "user" role with a [Compacted summary] prefix is the closest
		// in-message equivalent (pi uses a dedicated compactionSummary role
		// which we lack; the prefix signals the marker to the LLM).
		const summaryMessage: LLMMessage = {
			role: "user",
			content: `[Compacted summary — replaces ${cut.cutIndex} prior messages]\n\n${previousSummary}`,
		};

		logger?.info?.("pi.compaction.done", {
			before: history.length,
			after: 1 + keptMessages.length,
			summarizedCount: cut.cutIndex,
			summaryChars: previousSummary.length,
			tokensSummarized: cut.tokensInSummarize,
			tokensKept: cut.tokensInKept,
		});

		return [summaryMessage, ...keptMessages];
	};
}

/**
 * Single-shot LLM call for the summary. Uses naia-agent's `LLMClient`
 * streaming interface and concatenates text deltas. Throws on stream
 * error.
 */
async function callLLMForSummary(
	llm: LLMClient,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
): Promise<string> {
	const messages: LLMMessage[] = [
		{ role: "user", content: userPrompt },
	];
	let summary = "";
	const stream = llm.stream({
		system: systemPrompt,
		messages,
		tools: [],
		maxTokens,
		temperature: 0,
	});
	for await (const chunk of stream) {
		if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
			summary += chunk.delta.text;
		}
	}
	return summary;
}
