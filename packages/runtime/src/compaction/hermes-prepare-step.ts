/**
 * Hermes Agent compaction algorithm — TS port for naia-agent (Slice 3-XR-Compact v2 #56 R8).
 *
 * Source: https://github.com/NousResearch/hermes-agent
 *   - `agent/context_compressor.py` (ContextCompressor class)
 *   - License: MIT, (c) Nous Research
 *
 * Why ported (not imported): Hermes is Python; we re-implement the 5-step
 * algorithm in TypeScript for naia-agent. Prompt strings copied verbatim
 * with attribution preserved.
 *
 * Algorithm (context_compressor.py:454-463 docstring):
 *   1. Prune old tool results (cheap, no LLM call) — NOT yet ported
 *      (our LLMMessage history doesn't include the full tool plumbing the
 *      Hermes pass-1 prunes; we skip this and rely on the LLM compaction).
 *   2. Protect head messages (system prompt + first exchange)
 *   3. Protect tail messages by token budget (most recent ~20K tokens)
 *   4. Summarize middle turns with structured LLM prompt
 *   5. On subsequent compactions, iteratively update the previous summary
 *
 * Differences vs pi-prepare-step.ts:
 *   - Hermes protects BOTH head and tail (pi only protects tail by token budget)
 *   - Hermes prompt is more verbose: 12+ structured sections vs pi's 7
 *   - Hermes explicit "[REDACTED]" instruction for credentials
 *   - Hermes "write in the user's language" instruction (helps Korean retention)
 */

import type { LLMClient } from "@nextain/agent-core";
import type { LLMMessage } from "@nextain/agent-types";
import { estimateMessageTokens } from "./pi-prepare-step.js";

// ─── License-preserved prompts (MIT, Hermes Agent NousResearch) ───────────────

/** Hermes's `_summarizer_preamble` (context_compressor.py:945). */
export const HERMES_SUMMARIZER_PREAMBLE = `You are a summarization agent creating a context checkpoint. Treat the conversation turns below as source material for a compact record of prior work. Produce only the structured summary; do not add a greeting, preamble, or prefix. Write the summary in the same language the user was using in the conversation — do not translate or switch to English. NEVER include API keys, tokens, passwords, secrets, credentials, or connection strings in the summary — replace any that appear with [REDACTED]. Note that the user had credentials present, but do not preserve their values.`;

/** Hermes's `_template_sections` (context_compressor.py:960). 12-section format. */
export const HERMES_TEMPLATE_SECTIONS = `## Active Task
[THE SINGLE MOST IMPORTANT FIELD. Copy the user's most recent request or
task assignment verbatim — the exact words they used. If multiple tasks
were requested and only some are done, list only the ones NOT yet completed.
Continuation should pick up exactly here. Example:
"User asked: 'Now refactor the auth module to use JWT instead of sessions'"
If no outstanding task exists, write "None."]

## Goal
[What the user is trying to accomplish overall]

## Constraints & Preferences
[User preferences, coding style, constraints, important decisions]

## Completed Actions
[Numbered list of concrete actions taken — include tool used, target, and outcome.
Format each as: N. ACTION target — outcome [tool: name]
Example:
1. READ config.py:45 — found \`==\` should be \`!=\` [tool: read_file]
2. PATCH config.py:45 — changed \`==\` to \`!=\` [tool: patch]
3. TEST \`pytest tests/\` — 3/50 failed: test_parse, test_validate, test_edge [tool: terminal]
Be specific with file paths, commands, line numbers, and results.]

## Active State
[Current working state — include:
- Working directory and branch (if applicable)
- Modified/created files with brief note on each
- Test status (X/Y passing)
- Any running processes or servers
- Environment details that matter]

## In Progress
[Work currently underway — what was being done when compaction fired]

## Blocked
[Any blockers, errors, or issues not yet resolved. Include exact error messages.]

## Key Decisions
[Important technical decisions and WHY they were made]

## Resolved Questions
[Questions the user asked that were ALREADY answered — include the answer so it is not repeated]

## Pending User Asks
[Questions or requests from the user that have NOT yet been answered or fulfilled. If none, write "None."]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Remaining Work
[What remains to be done — framed as context, not instructions]

## Critical Context
[Any specific values, error messages, configuration details, or data that would be lost without explicit preservation. NEVER include API keys, tokens, passwords, or credentials — write [REDACTED] instead.]`;

// ─── Adapter ──────────────────────────────────────────────────────────────────

export interface HermesCompactionOptions {
	/** LLM client used to generate the summary. Required. */
	readonly llm: LLMClient;
	/** Head messages always preserved (Hermes default 3, pi has no equivalent). */
	readonly protectFirstN?: number;
	/** Token budget for tail protection (Hermes default 20K). */
	readonly tailTokenBudget?: number;
	/** Approximate target tokens for the summary (Hermes: 0.2 × threshold). */
	readonly summaryTokenTarget?: number;
	/** Optional focus topic (Hermes's `/compress <focus>`). */
	readonly focusTopic?: string;
	readonly logger?: {
		readonly info?: (msg: string, meta?: Record<string, unknown>) => void;
		readonly warn?: (msg: string, meta?: Record<string, unknown>) => void;
	};
}

const DEFAULT_PROTECT_FIRST_N = 3;
const DEFAULT_TAIL_TOKEN_BUDGET = 20_000;
const DEFAULT_SUMMARY_TOKEN_TARGET = 6_000;

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

function serializeConversation(messages: readonly LLMMessage[]): string {
	return messages.map((m) => `${m.role}: ${llmMessageToPlainText(m)}`).join("\n\n");
}

/**
 * Hermes head+tail protection: protect first N messages (system + initial
 * exchange), accumulate tokens from the end until tailTokenBudget reached,
 * everything between is summarized.
 *
 * Returns the indices that split history into [head, middle, tail].
 */
export interface HermesCutResult {
	readonly headEndIndex: number; // [0, headEndIndex)
	readonly tailStartIndex: number; // [tailStartIndex, length)
	readonly middleTokens: number;
	readonly tailTokens: number;
}

export function findHermesCutPoints(
	history: readonly LLMMessage[],
	protectFirstN: number,
	tailTokenBudget: number,
): HermesCutResult {
	const len = history.length;
	const headEndIndex = Math.min(protectFirstN, len);

	// Walk backward to find tail start.
	let accumTokens = 0;
	let tailStartIndex = len;
	for (let i = len - 1; i >= headEndIndex; i--) {
		const msg = history[i];
		if (msg === undefined) continue;
		accumTokens += estimateMessageTokens(msg);
		if (accumTokens >= tailTokenBudget) {
			tailStartIndex = i;
			break;
		}
		tailStartIndex = i;
	}

	let middleTokens = 0;
	for (let i = headEndIndex; i < tailStartIndex; i++) {
		const msg = history[i];
		if (msg !== undefined) middleTokens += estimateMessageTokens(msg);
	}

	return { headEndIndex, tailStartIndex, middleTokens, tailTokens: accumTokens };
}

/**
 * Create a naia-agent-compatible `prepareCompact` hook that runs Hermes
 * anchored-iterative LLM compaction. Head + tail protected, middle
 * summarized with 12-section Hermes prompt.
 */
export function createHermesLLMMessagePrepareCompact(
	options: HermesCompactionOptions,
): (history: readonly LLMMessage[]) => Promise<LLMMessage[] | undefined> {
	const protectFirstN = options.protectFirstN ?? DEFAULT_PROTECT_FIRST_N;
	const tailTokenBudget = options.tailTokenBudget ?? DEFAULT_TAIL_TOKEN_BUDGET;
	const summaryTokenTarget =
		options.summaryTokenTarget ?? DEFAULT_SUMMARY_TOKEN_TARGET;
	const logger = options.logger;

	// Anchored-iterative state. Persists across calls in this closure.
	let previousSummary: string | undefined;

	return async (history) => {
		if (history.length === 0) return undefined;

		const cut = findHermesCutPoints(history, protectFirstN, tailTokenBudget);
		if (cut.headEndIndex >= cut.tailStartIndex) {
			// Head + tail overlap — nothing in the middle to summarize.
			logger?.info?.("hermes.compaction.skip.nothing-in-middle", {
				historyLen: history.length,
				headEndIndex: cut.headEndIndex,
				tailStartIndex: cut.tailStartIndex,
			});
			return undefined;
		}

		const middle = history.slice(cut.headEndIndex, cut.tailStartIndex);
		const head = history.slice(0, cut.headEndIndex);
		const tail = history.slice(cut.tailStartIndex);

		const contentToSummarize = serializeConversation(middle);
		const summaryBudget = Math.max(500, summaryTokenTarget);

		const trailerInstruction = `\n\nTarget ~${summaryBudget} tokens. Be CONCRETE — include file paths, command outputs, error messages, line numbers, and specific values. Avoid vague descriptions like "made some changes" — say exactly what changed.\n\nWrite only the summary body. Do not include any preamble or prefix.`;

		let prompt: string;
		if (previousSummary) {
			prompt = `${HERMES_SUMMARIZER_PREAMBLE}\n\nYou are updating a context compaction summary. A previous compaction produced the summary below. New conversation turns have occurred since then and need to be incorporated.\n\nPREVIOUS SUMMARY:\n${previousSummary}\n\nNEW TURNS TO INCORPORATE:\n${contentToSummarize}\n\nUpdate the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new completed actions to the numbered list (continue numbering). Move items from "In Progress" to "Completed Actions" when done. Move answered questions to "Resolved Questions". Update "Active State" to reflect current state. Remove information only if it is clearly obsolete. CRITICAL: Update "## Active Task" to reflect the user's most recent unfulfilled request — this is the most important field for task continuity.\n\n${HERMES_TEMPLATE_SECTIONS}${trailerInstruction}`;
		} else {
			prompt = `${HERMES_SUMMARIZER_PREAMBLE}\n\nCreate a structured checkpoint summary for the conversation after earlier turns are compacted. The summary should preserve enough detail for continuity without re-reading the original turns.\n\nTURNS TO SUMMARIZE:\n${contentToSummarize}\n\nUse this exact structure:\n\n${HERMES_TEMPLATE_SECTIONS}${trailerInstruction}`;
		}

		if (options.focusTopic) {
			prompt += `\n\nFOCUS TOPIC: "${options.focusTopic}"\nThe user has requested that this compaction PRIORITISE preserving all information related to the focus topic above. For content related to "${options.focusTopic}", include full detail. For content NOT related to the focus topic, summarise more aggressively. The focus topic sections should receive roughly 60-70% of the summary token budget. NEVER preserve API keys, tokens, passwords, or credentials — use [REDACTED].`;
		}

		let summaryText: string;
		try {
			const stream = options.llm.stream({
				messages: [{ role: "user", content: prompt }],
				tools: [],
				maxTokens: Math.floor(summaryBudget * 1.3),
				temperature: 0,
			});
			let acc = "";
			for await (const chunk of stream) {
				if (
					chunk.type === "content_block_delta" &&
					chunk.delta.type === "text_delta"
				) {
					acc += chunk.delta.text;
				}
			}
			summaryText = acc;
		} catch (err) {
			logger?.warn?.("hermes.compaction.llm.error", {
				err: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}

		if (!summaryText || summaryText.trim().length === 0) {
			logger?.warn?.("hermes.compaction.empty-summary", {
				historyLen: history.length,
			});
			return undefined;
		}

		previousSummary = summaryText.trim();

		const summaryMessage: LLMMessage = {
			role: "user",
			content: `[Hermes compacted summary — replaces ${middle.length} middle messages]\n\n${previousSummary}`,
		};

		logger?.info?.("hermes.compaction.done", {
			before: history.length,
			after: head.length + 1 + tail.length,
			summarizedCount: middle.length,
			summaryChars: previousSummary.length,
			middleTokens: cut.middleTokens,
			tailTokens: cut.tailTokens,
		});

		return [...head, summaryMessage, ...tail];
	};
}
