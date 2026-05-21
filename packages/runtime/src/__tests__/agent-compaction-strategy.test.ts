// Slice 3-XR-Compact (#47) P4 + P5 — strategy wire-up integration tests.
//
// P4 (Realtime): verifies the Agent forwards `strategy` and `sessionId` to
// memory.compact(), and (on the second round) `priorRecap` carries the
// previous compaction's summary — i.e. anchored iterative summarization
// flows end-to-end from the agent loop.
//
// P5 (Anthropic-native / off): verifies the Agent short-circuits — when
// strategy = "anthropic-native" or "off", memory.compact() is NEVER
// called even when the context budget is wildly exceeded.

import { describe, it, expect } from "vitest";
import { Agent } from "@nextain/agent-core";
import type {
	CompactableCapable,
	CompactionInput,
	CompactionResult,
	CompactionStrategy,
	ConsolidationSummary,
	LLMClient,
	LLMRequest,
	LLMStreamChunk,
	MemoryHit,
	MemoryInput,
	MemoryProvider,
} from "@nextain/agent-types";
import { createHost } from "../host/create-host.js";

/**
 * Mock memory that captures every compact() input — strategy hint,
 * priorRecap, sessionId. Returns a deterministic recap so we can chain.
 */
class CapturingMemory implements MemoryProvider, CompactableCapable {
	readonly captured: CompactionInput[] = [];
	#round = 0;
	async encode(_: MemoryInput): Promise<void> {}
	async recall(_: string): Promise<MemoryHit[]> {
		return [];
	}
	async consolidate(): Promise<ConsolidationSummary> {
		return { factsCreated: 0, durationMs: 0 };
	}
	async close(): Promise<void> {}
	async compact(input: CompactionInput): Promise<CompactionResult> {
		this.captured.push({ ...input, messages: [...input.messages] });
		this.#round++;
		return {
			summary: {
				role: "assistant",
				content: `[ROUND-${this.#round} recap of ${input.messages.length} messages]`,
				timestamp: Date.now(),
			},
			droppedCount: input.messages.length,
			realtime: input.strategy === "realtime",
		};
	}
}

/**
 * Scripted LLM with one-character text replies — keeps the loop predictable
 * while we focus on the compaction-trigger path.
 */
class TinyLLM implements LLMClient {
	#i = 0;
	constructor(private readonly turns: string[]) {}
	async generate(): Promise<never> {
		throw new Error("not used");
	}
	async *stream(_: LLMRequest): AsyncIterable<LLMStreamChunk> {
		const txt = this.turns[Math.min(this.#i, this.turns.length - 1)] ?? "ok";
		this.#i++;
		yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: txt },
			};
	}
}

async function runAgent(
	strategy: CompactionStrategy,
	userTurns: number,
	estimatedTokensPerCall: number,
): Promise<CapturingMemory> {
	const memory = new CapturingMemory();
	const host = createHost({
		llm: new TinyLLM(Array(userTurns).fill("noted.")),
		memory,
		logger: { debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
	});
	const agent = new Agent({
		host,
		// Force budget exceed on every turn so #maybeCompact considers
		// compaction. Estimator returns a fixed huge value.
		estimateTokens: () => estimatedTokensPerCall,
		contextBudget: 1_000,
		compactionKeepTail: 2,
		compactionStrategy: strategy,
	});
	for (let i = 0; i < userTurns; i++) {
		// Drain the stream.
		// biome-ignore lint/correctness/noUnusedVariables: drain only
		for await (const _ of agent.sendStream(`turn ${i}`)) {
			/* drain */
		}
	}
	return memory;
}

describe("Agent compaction strategy wire-up (Slice 3-XR-Compact #47 P4/P5)", () => {
	it("P4-01 strategy=realtime forwards strategy + sessionId to memory.compact()", async () => {
		const memory = await runAgent("realtime", 5, 50_000);
		expect(memory.captured.length).toBeGreaterThan(0);
		const first = memory.captured[0]!;
		expect(first.strategy).toBe("realtime");
		expect(first.sessionId).toBeDefined();
		expect(typeof first.sessionId).toBe("string");
		expect((first.sessionId ?? "").length).toBeGreaterThan(0);
	});

	it("P4-02 strategy=reactive (default-like) forwards strategy=reactive", async () => {
		const memory = await runAgent("reactive", 4, 50_000);
		expect(memory.captured.length).toBeGreaterThan(0);
		expect(memory.captured[0]!.strategy).toBe("reactive");
	});

	it("P4-03 second compaction carries priorRecap from first (anchored iterative)", async () => {
		// 5 user turns over a 1k budget → at least 2 compactions expected.
		const memory = await runAgent("reactive", 5, 50_000);
		expect(memory.captured.length).toBeGreaterThanOrEqual(2);
		const second = memory.captured[1]!;
		expect(second.priorRecap).toBeDefined();
		expect(second.priorRecap?.content).toContain("ROUND-1 recap");
		// First compaction has no priorRecap.
		expect(memory.captured[0]!.priorRecap).toBeUndefined();
	});

	it("P5-01 strategy=anthropic-native does NOT invoke memory.compact()", async () => {
		// Estimate would be 100k vs budget 1k → ordinarily compact every turn.
		// But anthropic-native short-circuits.
		const memory = await runAgent("anthropic-native", 5, 100_000);
		expect(memory.captured.length).toBe(0);
	});

	it("P5-02 strategy=off does NOT invoke memory.compact()", async () => {
		const memory = await runAgent("off", 5, 100_000);
		expect(memory.captured.length).toBe(0);
	});

	it("P5-03 strategy=reactive DOES invoke memory.compact() under budget pressure (sanity)", async () => {
		const memory = await runAgent("reactive", 3, 100_000);
		expect(memory.captured.length).toBeGreaterThan(0);
	});
});
