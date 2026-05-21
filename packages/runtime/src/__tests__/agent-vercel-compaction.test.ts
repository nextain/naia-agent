// Slice 3-XR-Compact v2 / Phase 1.2 (#56) — Agent.sendStream integration
// for the Vercel `pruneMessages` reactive path.
//
// Verifies the **double-compaction guard**: when `prepareCompact` is wired
// AND `compactionStrategy === "reactive"`, the in-house `memory.compact()`
// path is SKIPPED. Exactly one compaction codepath runs per turn.

import { describe, expect, it, vi } from "vitest";
import { Agent } from "@nextain/agent-core";
import type {
	CompactableCapable,
	CompactionInput,
	CompactionResult,
	CompactionStrategy,
	ConsolidationSummary,
	LLMClient,
	LLMMessage,
	LLMRequest,
	LLMStreamChunk,
	MemoryHit,
	MemoryInput,
	MemoryProvider,
} from "@nextain/agent-types";
import { createHost } from "../host/create-host.js";
import { createLLMMessagePrepareCompact } from "../compaction/vercel-prepare-step.js";

class CapturingMemory implements MemoryProvider, CompactableCapable {
	readonly captured: CompactionInput[] = [];
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
		return {
			summary: {
				role: "assistant",
				content: `[memory.compact recap of ${input.messages.length}]`,
				timestamp: Date.now(),
			},
			droppedCount: input.messages.length,
			realtime: false,
		};
	}
}

class TinyLLM implements LLMClient {
	#i = 0;
	constructor(private readonly turns: string[]) {}
	async generate(): Promise<never> {
		throw new Error("not used");
	}
	async *stream(_: LLMRequest): AsyncIterable<LLMStreamChunk> {
		const txt = this.turns[Math.min(this.#i, this.turns.length - 1)] ?? "ok";
		this.#i++;
		// Emit a single content_block to satisfy the agent stream contract.
		yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
		yield {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: txt },
		};
		yield { type: "content_block_stop", index: 0 };
		yield {
			type: "end",
			stopReason: "end_turn",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
	}
}

interface RunResult {
	memory: CapturingMemory;
	prepareCalls: number;
	compactionEvents: number;
}

async function runAgent(opts: {
	strategy: CompactionStrategy;
	userTurns: number;
	estimatedTokens: number;
	withPrepareCompact: boolean;
}): Promise<RunResult> {
	const memory = new CapturingMemory();
	const host = createHost({
		llm: new TinyLLM(Array(opts.userTurns).fill("noted.")),
		memory,
		logger: {
			trace() {},
			debug() {},
			info() {},
			warn() {},
			error() {},
		} as never,
	});
	let prepareCalls = 0;
	const prepare = opts.withPrepareCompact
		? (history: readonly LLMMessage[]) => {
			prepareCalls++;
			// Use the real factory so we exercise the SDK path end-to-end.
			return createLLMMessagePrepareCompact()(history);
		}
		: undefined;
	const agent = new Agent({
		host,
		estimateTokens: () => opts.estimatedTokens,
		contextBudget: 1_000,
		compactionKeepTail: 2,
		compactionStrategy: opts.strategy,
		// Disable auto-handoff so we observe ONLY the compact path. The
		// handoff path also calls memory.compact() (via exportHandoff with
		// keepTail:0) — that's a separate feature (Slice 3-XR-Handoff #50)
		// and is covered by its own test.
		handoffThreshold: 0,
		...(prepare ? { prepareCompact: prepare } : {}),
	});
	let compactionEvents = 0;
	for (let i = 0; i < opts.userTurns; i++) {
		for await (const ev of agent.sendStream(`turn ${i}`)) {
			if (ev.type === "compaction") compactionEvents++;
		}
	}
	return { memory, prepareCalls, compactionEvents };
}

describe("Agent.sendStream prepareCompact integration (Phase 1.2 / #56)", () => {
	it("AVC-01: reactive + prepareCompact wired → memory.compact() NEVER called", async () => {
		const r = await runAgent({
			strategy: "reactive",
			userTurns: 3,
			estimatedTokens: 100_000, // far above 1k budget
			withPrepareCompact: true,
		});
		expect(r.memory.captured.length).toBe(0);
		expect(r.prepareCalls).toBeGreaterThan(0);
	});

	it("AVC-02: reactive WITHOUT prepareCompact → memory.compact() runs (regression guard)", async () => {
		const r = await runAgent({
			strategy: "reactive",
			userTurns: 3,
			estimatedTokens: 100_000,
			withPrepareCompact: false,
		});
		expect(r.memory.captured.length).toBeGreaterThan(0);
		expect(r.prepareCalls).toBe(0);
	});

	it("AVC-03: double-compaction guard — `compaction` event fires at most once per over-budget turn", async () => {
		// Use an always-shrinks deterministic prepare so we can assert the
		// emission count without depending on pruneMessages's behaviour for
		// plain-text histories (which is no-op — see AVC-08).
		const memory = new CapturingMemory();
		const host = createHost({
			llm: new TinyLLM(["a", "b"]),
			memory,
			logger: {
				trace() {},
				debug() {},
				info() {},
				warn() {},
				error() {},
			} as never,
		});
		const agent = new Agent({
			host,
			estimateTokens: () => 100_000,
			contextBudget: 1_000,
			compactionStrategy: "reactive",
			handoffThreshold: 0,
			prepareCompact: (h) => (h.length > 1 ? h.slice(-1) : undefined),
		});
		let compactionEvents = 0;
		for (let i = 0; i < 2; i++) {
			for await (const ev of agent.sendStream(`turn ${i}`)) {
				if (ev.type === "compaction") compactionEvents++;
			}
		}
		// One compaction per over-budget turn; never two on the same turn.
		expect(compactionEvents).toBeGreaterThan(0);
		expect(compactionEvents).toBeLessThanOrEqual(2);
		expect(memory.captured.length).toBe(0);
	});

	it("AVC-08 (codex R1 #1): no-op prune → NO compaction event, NO fallback to memory.compact()", async () => {
		// With plain-text history, pruneMessages cookbook defaults are a
		// no-op. The factory rejects no-op results (returns undefined), so
		// the Agent emits NO compaction event. Crucially, it ALSO does NOT
		// fall back to memory.compact() — the "exactly one path" contract
		// holds even on no-op.
		const r = await runAgent({
			strategy: "reactive",
			userTurns: 3,
			estimatedTokens: 100_000,
			withPrepareCompact: true,
		});
		expect(r.memory.captured.length).toBe(0);
		expect(r.compactionEvents).toBe(0);
		// prepareCompact was invoked (over-budget gate) but returned undefined.
		expect(r.prepareCalls).toBeGreaterThan(0);
	});

	it("AVC-04: strategy=off + prepareCompact wired → prepareCompact NEVER called", async () => {
		const r = await runAgent({
			strategy: "off",
			userTurns: 3,
			estimatedTokens: 100_000,
			withPrepareCompact: true,
		});
		expect(r.prepareCalls).toBe(0);
		expect(r.memory.captured.length).toBe(0);
	});

	it("AVC-05: strategy=anthropic-native + prepareCompact wired → prepareCompact NEVER called", async () => {
		const r = await runAgent({
			strategy: "anthropic-native",
			userTurns: 3,
			estimatedTokens: 100_000,
			withPrepareCompact: true,
		});
		expect(r.prepareCalls).toBe(0);
		expect(r.memory.captured.length).toBe(0);
	});

	it("AVC-06: reactive + prepareCompact + under budget → neither path runs", async () => {
		const r = await runAgent({
			strategy: "reactive",
			userTurns: 3,
			estimatedTokens: 10, // way below budget
			withPrepareCompact: true,
		});
		expect(r.prepareCalls).toBe(0);
		expect(r.memory.captured.length).toBe(0);
	});

	it("AVC-07: prepareCompact throwing is swallowed (turn survives)", async () => {
		const memory = new CapturingMemory();
		const host = createHost({
			llm: new TinyLLM(["ok"]),
			memory,
			logger: {
				trace() {},
				debug() {},
				info() {},
				warn: vi.fn(),
				error() {},
			} as never,
		});
		const boom = vi.fn(() => {
			throw new Error("prepare boom");
		});
		const agent = new Agent({
			host,
			estimateTokens: () => 100_000,
			contextBudget: 1_000,
			compactionStrategy: "reactive",
			prepareCompact: boom,
		});
		let finished = false;
		for await (const ev of agent.sendStream("hi")) {
			if (ev.type === "turn.ended") finished = true;
		}
		expect(finished).toBe(true);
		expect(boom).toHaveBeenCalled();
		// memory.compact() was NOT called (double-compaction guard holds even
		// when prepareCompact errors — host must repair, not Agent fallback).
		expect(memory.captured.length).toBe(0);
	});
});
