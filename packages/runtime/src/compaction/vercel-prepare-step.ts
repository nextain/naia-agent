/**
 * Vercel AI SDK `prepareStep` + `pruneMessages` 차용 — Slice 3-XR-Compact v2
 * Phase 1 (nextain/naia-agent#56).
 *
 * 외부 검증 base: `ai` 패키지의 `pruneMessages` helper (이미 우리 dep).
 * 출처: `ref-vercel-ai-sdk/content/cookbook/00-guides/08-agent-context-compaction.mdx`.
 *
 * 핵심 결정 (사용자 directive 2026-05-21):
 *   reactive = "외부 검증된 로직 차용" — naia 자체 toy 5-section markdown 폐기,
 *   Vercel AI SDK 의 production-grade pattern 그대로 채택.
 *
 * 사용 예시 (host code in `bin/naia-agent.ts` 또는 examples/*):
 *
 * ```ts
 * import { createVercelCompactionPrepareStep } from "@nextain/agent-runtime";
 * import { streamText } from "ai";
 *
 * const prepareStep = createVercelCompactionPrepareStep({
 *   compactAfterTokens: 100_000,
 * });
 *
 * const result = await streamText({
 *   model,
 *   prompt: "...",
 *   prepareStep,
 *   stopWhen: isStepCount(10),
 * });
 * ```
 */

import { pruneMessages } from "ai";
import type { ModelMessage } from "ai";

/**
 * Default rough token estimate — chars/4 heuristic from the cookbook.
 * Host code can swap in a provider-accurate tokenizer via the `estimateTokens`
 * option. This is what `prepareStep` calls to decide WHEN to compact.
 */
export function defaultEstimateTokens(messages: readonly ModelMessage[]): number {
	return JSON.stringify(messages).length / 4;
}

/**
 * Options for `createVercelCompactionPrepareStep`.
 *
 * Default values mirror the cookbook example — change them only when you
 * know what you're doing (e.g. smaller `compactAfterTokens` for tighter
 * budgets, custom `estimateTokens` for provider-accurate counts).
 */
export interface VercelCompactionOptions {
	/** Token threshold above which compaction fires. Default: 100_000. */
	readonly compactAfterTokens?: number;
	/** Optional token estimator override. Default: chars/4 heuristic. */
	readonly estimateTokens?: (messages: readonly ModelMessage[]) => number;
	/**
	 * Optional callback fired when compaction triggers — useful for host
	 * observability ("compaction event", token counts before/after).
	 * Synchronous; runs inside `prepareStep`, so keep it light.
	 */
	readonly onCompact?: (info: {
		beforeTokens: number;
		messagesBefore: number;
		messagesAfter: number;
	}) => void;
}

/**
 * Internal shape of the `prepareStep` callback parameter as documented by
 * the AI SDK. We type it loosely (`readonly ModelMessage[]`) so the helper
 * works with any caller's version of `ai` — strict typing happens at the
 * call site through SDK's own type inference.
 */
export interface PrepareStepInput {
	readonly messages: readonly ModelMessage[];
	readonly initialMessages?: readonly ModelMessage[];
	readonly responseMessages?: readonly ModelMessage[];
	readonly stepNumber?: number;
}

export type PrepareStepResult = { messages: ModelMessage[] } | undefined;

/**
 * Build a `prepareStep` callback that runs the cookbook's compaction logic:
 *
 *   1. Estimate tokens of the current step's messages.
 *   2. If above threshold, call `pruneMessages` with the cookbook's defaults:
 *      - `reasoning: 'all'` — drop thinking blocks
 *      - `toolCalls: 'before-last-3-messages'` — preserve recent tool turns
 *      - `emptyMessages: 'remove'` — clean up the array
 *   3. Return `{ messages: pruned }`, otherwise return `undefined`
 *      (no mutation — the SDK keeps current messages).
 *
 * This is the EXACT cookbook recipe. naia-agent's contribution at this layer
 * is the integration glue + the observability callback — not a custom
 * compaction algorithm.
 */
export function createVercelCompactionPrepareStep(
	options: VercelCompactionOptions = {},
): (input: PrepareStepInput) => PrepareStepResult {
	const threshold = options.compactAfterTokens ?? 100_000;
	const estimator = options.estimateTokens ?? defaultEstimateTokens;
	const onCompact = options.onCompact;

	return ({ messages }) => {
		const beforeTokens = estimator(messages);
		if (beforeTokens <= threshold) return undefined;

		const pruned = pruneMessages({
			messages,
			reasoning: "all",
			toolCalls: "before-last-3-messages",
			emptyMessages: "remove",
		});

		onCompact?.({
			beforeTokens,
			messagesBefore: messages.length,
			messagesAfter: pruned.length,
		});

		return { messages: pruned };
	};
}
