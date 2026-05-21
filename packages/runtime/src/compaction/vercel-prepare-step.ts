/**
 * Vercel AI SDK `prepareStep` + `pruneMessages` 차용 — Slice 3-XR-Compact v2
 * Phase 1 (nextain/naia-agent#56), Ralph R2 (4-AI cross-review 반영).
 *
 * 외부 검증 base: `ai` 패키지의 `pruneMessages` helper (이미 우리 dep).
 * 출처: `ref-vercel-ai-sdk/content/cookbook/00-guides/08-agent-context-compaction.mdx`.
 *
 * ## R1 → R2 변경 (cross-review 반영)
 *
 * - **opencode**: 타입 이름이 SDK 의 `PrepareStepInput` 과 shadow → 우리 타입
 *   `CompactionStepInput` / `CompactionStepResult` 로 rename
 * - **opencode**: `ai` 가 runtime/package.json 에 없음 → 추가 (별 commit)
 * - **gemini**: `pruneMessages` 옵션 override 불가 → `pruneOptions` 추가
 * - **codex**: Agent.sendStream 의 기존 `memory.compact()` 와 충돌 → architecture
 *   note 명시 + Agent 통합은 별 phase (current change 는 helper-only)
 * - **codex / opencode**: threshold 동치 boundary test 추가 (별 파일)
 * - **codex**: onCompact throw 안전성 → try/catch + 로깅 옵션
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
 *
 * ## Architecture note (codex 지적)
 *
 * naia-agent 의 `Agent.sendStream()` 은 현재 `memory.compact()` 를 별도로
 * 호출하는 in-house compaction path 보유. 이 helper 를 직접 wire-in 하면
 * **double compaction** 위험. 통합 시 둘 중 하나 비활성 필수.
 *
 * 결정 (Phase 1 scope): 본 helper 는 standalone helper 로 export 만. 실제
 * `Agent.sendStream` 통합은 Phase 1.2 에서 진행 — 기존 #maybeCompact 비활성
 * 옵션 + prepareStep 활성 옵션 같이 wire.
 */

import { pruneMessages } from "ai";
import type { ModelMessage } from "ai";
import type {
	LLMContentBlock,
	LLMMessage,
} from "@nextain/agent-types";

/**
 * Default rough token estimate — chars/4 heuristic from the cookbook.
 *
 * ⚠️ Multi-modal limitation (gemini 지적): base64 images / 큰 JSON tool
 * results 가 있는 messages 에서 부정확. Host code 가 provider-accurate
 * tokenizer 를 `estimateTokens` option 으로 inject 권장.
 */
export function defaultEstimateTokens(messages: readonly ModelMessage[]): number {
	return JSON.stringify(messages).length / 4;
}

/**
 * Options accepted by `pruneMessages` from the AI SDK — sourced from the SDK
 * type directly (sans `messages`) so we never drift from upstream.
 *
 * Phase 1.2 (#56) note: prior R2 hand-rolled type used stale literals
 * (`"keep-all"` / `"remove-all"` / `"keep-last"`) that the SDK does not accept.
 * Tracking SDK exactly removes that surface entirely (gemini cross-review
 * intent, but pinned to actual SDK rather than the cookbook MDX).
 */
export type PruneMessagesOptions = Omit<
	Parameters<typeof pruneMessages>[0],
	"messages"
>;

/**
 * Cookbook defaults — exported so tests and hosts can compare against the
 * canonical recipe (Vercel AI SDK cookbook
 * `08-agent-context-compaction.mdx`).
 */
export const COOKBOOK_PRUNE_OPTIONS: PruneMessagesOptions = {
	reasoning: "all",
	toolCalls: "before-last-3-messages",
	emptyMessages: "remove",
};

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
	 * Override the `pruneMessages` options. Default: `COOKBOOK_PRUNE_OPTIONS`.
	 * Useful when a host wants to keep all tool calls (`keep-all`) or strip
	 * empty messages differently.
	 */
	readonly pruneOptions?: PruneMessagesOptions;
	/**
	 * Optional callback fired when compaction triggers — useful for host
	 * observability ("compaction event", token counts before/after).
	 * Synchronous; thrown errors are caught + logged via `onError`, not
	 * propagated into the step pipeline (codex review).
	 */
	readonly onCompact?: (info: {
		beforeTokens: number;
		messagesBefore: number;
		messagesAfter: number;
	}) => void;
	/**
	 * Optional error logger. Called when the estimator returns an invalid
	 * value (NaN / negative / throw), when `pruneMessages` throws, or when
	 * `onCompact` throws. Default: silent (errors swallowed so step pipeline
	 * survives).
	 */
	readonly onError?: (err: Error, phase: "estimate" | "prune" | "onCompact") => void;
}

/**
 * Input shape for our compaction-specific prepareStep callback.
 *
 * **NOTE** (opencode review): the AI SDK 's own `PrepareStepInput` /
 * `PrepareStepFunction` exports a different shape (`steps`, `model`,
 * `experimental_context`, ...). We name our local type `CompactionStepInput`
 * to avoid shadowing the SDK's type. Host code that wants to use this with
 * the SDK's `prepareStep` option will need a thin adapter to bridge the
 * two signatures (a future phase concern; current scope is the helper itself).
 */
export interface CompactionStepInput {
	readonly messages: readonly ModelMessage[];
	readonly initialMessages?: readonly ModelMessage[];
	readonly responseMessages?: readonly ModelMessage[];
	readonly stepNumber?: number;
}

export type CompactionStepResult = { messages: ModelMessage[] } | undefined;

/**
 * Build a compaction-step callback that runs the cookbook's recipe:
 *
 *   1. Estimate tokens of the current step's messages.
 *   2. If above threshold, call `pruneMessages` with cookbook defaults
 *      (or `options.pruneOptions` override).
 *   3. Return `{ messages: pruned }`, otherwise return `undefined`
 *      (no mutation — the SDK keeps current messages).
 *
 * naia-agent's contribution: configurable + observability + error-safety
 * wrapper. The compaction algorithm itself is upstream (Vercel AI SDK).
 */
export function createVercelCompactionPrepareStep(
	options: VercelCompactionOptions = {},
): (input: CompactionStepInput) => CompactionStepResult {
	const threshold = options.compactAfterTokens ?? 100_000;
	const estimator = options.estimateTokens ?? defaultEstimateTokens;
	const pruneOpts: PruneMessagesOptions =
		options.pruneOptions ?? COOKBOOK_PRUNE_OPTIONS;
	const onCompact = options.onCompact;
	const onError = options.onError;

	return ({ messages }): CompactionStepResult => {
		// estimator can throw or return NaN/negative — guard.
		let beforeTokens: number;
		try {
			beforeTokens = estimator(messages);
		} catch (err) {
			onError?.(err instanceof Error ? err : new Error(String(err)), "estimate");
			return undefined;
		}
		if (
			!Number.isFinite(beforeTokens) ||
			beforeTokens < 0 ||
			beforeTokens <= threshold
		) {
			return undefined;
		}

		let pruned: ModelMessage[];
		try {
			pruned = pruneMessages({
				// pruneMessages declares `ModelMessage[]` (mutable); we hold a
				// readonly view but never mutate. Cast at the boundary.
				messages: messages as ModelMessage[],
				...pruneOpts,
			});
		} catch (err) {
			onError?.(err instanceof Error ? err : new Error(String(err)), "prune");
			return undefined;
		}

		try {
			onCompact?.({
				beforeTokens,
				messagesBefore: messages.length,
				messagesAfter: pruned.length,
			});
		} catch (err) {
			onError?.(err instanceof Error ? err : new Error(String(err)), "onCompact");
			// fall through — pruning succeeded; observability error doesn't
			// invalidate the result.
		}

		return { messages: pruned };
	};
}

// ────────────────────────────────────────────────────────────────────────
// Phase 1.2 (#56) — LLMMessage ↔ ModelMessage adapter + Agent-side factory
//
// Reason for the adapter layer: naia-agent's core `Agent` operates on
// `@nextain/agent-types` `LLMMessage` (Anthropic-style content blocks). The
// Vercel SDK's `pruneMessages` operates on `ModelMessage` (Vercel's own
// shape). Core MUST NOT depend on the `ai` SDK (layering), so the
// integration runs through an injected callback whose body lives here.
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert a naia `LLMMessage` to a Vercel `ModelMessage`. Lossy by design —
 * `redacted_thinking` blocks are dropped (no SDK part for them); cache
 * breakpoints are not preserved (we're pruning, not requesting). Round-trip
 * fidelity is best-effort — the goal is to let `pruneMessages` operate on a
 * shape it understands, not to be a generic adapter.
 */
export function llmMessageToModelMessage(msg: LLMMessage): ModelMessage {
	if (msg.role === "tool") {
		const blocks =
			typeof msg.content === "string"
				? [{ type: "text" as const, text: msg.content }]
				: msg.content;
		const toolParts = blocks
			.filter(
				(b): b is LLMContentBlock & { type: "tool_result" } =>
					b.type === "tool_result",
			)
			.map((b) => ({
				type: "tool-result" as const,
				toolCallId: b.toolCallId,
				toolName: "",
				output: { type: "text" as const, value: b.content },
			}));
		return { role: "tool", content: toolParts };
	}

	if (typeof msg.content === "string") {
		return { role: msg.role, content: msg.content } as ModelMessage;
	}

	if (msg.role === "user") {
		const parts = msg.content
			.map((b) => llmBlockToUserPart(b))
			.filter(
				(p): p is NonNullable<ReturnType<typeof llmBlockToUserPart>> =>
					p !== undefined,
			);
		return { role: "user", content: parts };
	}

	const parts = msg.content
		.map((b) => llmBlockToAssistantPart(b))
		.filter(
			(p): p is NonNullable<ReturnType<typeof llmBlockToAssistantPart>> =>
				p !== undefined,
		);
	return { role: "assistant", content: parts };
}

function llmBlockToUserPart(block: LLMContentBlock) {
	if (block.type === "text") return { type: "text" as const, text: block.text };
	if (block.type === "image") {
		return {
			type: "file" as const,
			data: block.source.data,
			mediaType: block.source.mediaType,
		};
	}
	return undefined;
}

function llmBlockToAssistantPart(block: LLMContentBlock) {
	if (block.type === "text") return { type: "text" as const, text: block.text };
	if (block.type === "thinking") {
		return { type: "reasoning" as const, text: block.thinking };
	}
	if (block.type === "tool_use") {
		return {
			type: "tool-call" as const,
			toolCallId: block.id,
			toolName: block.name,
			input: block.input,
		};
	}
	return undefined;
}

/**
 * Convert a Vercel `ModelMessage` back to a naia `LLMMessage`. Round-trips
 * the shapes we emit; for shapes we never emit (e.g. assistant file parts),
 * returns a best-effort fallback rather than throwing.
 */
export function modelMessageToLLMMessage(msg: ModelMessage): LLMMessage {
	if (msg.role === "tool") {
		const content: LLMContentBlock[] = [];
		const parts = Array.isArray(msg.content) ? msg.content : [];
		for (const p of parts) {
			if (
				p &&
				typeof p === "object" &&
				"type" in p &&
				p.type === "tool-result"
			) {
				const outputValue =
					p.output && typeof p.output === "object" && "value" in p.output
						? String((p.output as { value: unknown }).value ?? "")
						: "";
				content.push({
					type: "tool_result",
					toolCallId: p.toolCallId,
					content: outputValue,
				});
			}
		}
		return { role: "tool", content };
	}

	// System role narrows out at the LLMMessage boundary — naia-agent carries
	// system text as `LLMRequest.system`, not as a message. Fold it into an
	// assistant text message so pruneMessages output stays representable.
	const role: "user" | "assistant" =
		msg.role === "user" ? "user" : "assistant";

	if (typeof msg.content === "string") {
		return { role, content: msg.content };
	}

	const blocks: LLMContentBlock[] = [];
	for (const p of msg.content) {
		if (p.type === "text") {
			blocks.push({ type: "text", text: p.text });
		} else if (p.type === "reasoning") {
			blocks.push({ type: "thinking", thinking: p.text });
		} else if (p.type === "tool-call") {
			blocks.push({
				type: "tool_use",
				id: p.toolCallId,
				name: p.toolName,
				input: p.input,
			});
		} else if (p.type === "file" && typeof p.data === "string") {
			blocks.push({
				type: "image",
				source: {
					type: "base64",
					mediaType: p.mediaType,
					data: p.data,
				},
			});
		}
	}
	return { role, content: blocks };
}

/**
 * Agent-side compaction hook — factory for `AgentOptions.prepareCompact`.
 *
 * The returned callback:
 *  1. Converts the Agent's `LLMMessage[]` history to `ModelMessage[]`.
 *  2. Delegates to the cookbook helper (`pruneMessages` under the hood).
 *  3. Converts the pruned result back to `LLMMessage[]`.
 *  4. Returns `undefined` to signal "no compaction performed" — the Agent
 *     leaves its history untouched.
 *
 * Default `compactAfterTokens` is **0** so the Agent's own `contextBudget`
 * gate is the authoritative trigger (the Agent only invokes this when
 * already over budget). Hosts that want double-gating can pass a positive
 * `compactAfterTokens`.
 *
 * Double-compaction guard: when this hook is wired, the Agent skips its
 * in-house `memory.compact()` path entirely for the reactive strategy.
 * Exactly one compaction path runs per turn — never both.
 */
export function createLLMMessagePrepareCompact(
	options: VercelCompactionOptions = {},
): (history: readonly LLMMessage[]) => LLMMessage[] | undefined {
	const inner = createVercelCompactionPrepareStep({
		compactAfterTokens: 0,
		...options,
	});
	return (history) => {
		if (history.length === 0) return undefined;
		const modelMessages = history.map(llmMessageToModelMessage);
		const result = inner({ messages: modelMessages });
		if (!result) return undefined;
		const pruned = result.messages.map(modelMessageToLLMMessage);
		// Safety: never wipe non-empty history to empty (e.g. pathological
		// prune output). Caller treats `undefined` as "skip".
		if (pruned.length === 0) return undefined;
		return pruned;
	};
}
