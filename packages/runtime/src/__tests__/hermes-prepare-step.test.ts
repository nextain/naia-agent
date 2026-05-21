/**
 * hermes-prepare-step.ts unit tests — R8 Slice 3-XR-Compact v2 #56.
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMClient, LLMStreamChunk } from "@nextain/agent-core";
import type { LLMMessage } from "@nextain/agent-types";
import {
	createHermesLLMMessagePrepareCompact,
	findHermesCutPoints,
	HERMES_SUMMARIZER_PREAMBLE,
	HERMES_TEMPLATE_SECTIONS,
} from "../compaction/hermes-prepare-step.js";

function mkMsg(role: LLMMessage["role"], text: string): LLMMessage {
	return { role, content: text };
}

function buildLongHistory(n: number, charsPerMsg: number): LLMMessage[] {
	return Array.from({ length: n }, (_, i) =>
		mkMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMsg)),
	);
}

function mkLLMStub(summary: string): LLMClient {
	return {
		generate: vi.fn(),
		stream: vi.fn(async function* (): AsyncIterable<LLMStreamChunk> {
			yield { type: "start", id: "test", model: "stub" };
			yield {
				type: "content_block_start",
				index: 0,
				block: { type: "text", text: "" },
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: summary },
			};
			yield { type: "content_block_stop", index: 0 };
			yield {
				type: "end",
				stopReason: "end_turn",
				usage: { inputTokens: 100, outputTokens: 50 },
			};
		}),
	} as unknown as LLMClient;
}

describe("findHermesCutPoints", () => {
	it("HCP-01: empty history → head=tail=0", () => {
		const r = findHermesCutPoints([], 3, 1000);
		expect(r.headEndIndex).toBe(0);
		expect(r.tailStartIndex).toBe(0);
	});

	it("HCP-02: small history → head + tail overlap (no middle)", () => {
		const hist = buildLongHistory(5, 40);
		const r = findHermesCutPoints(hist, 3, 10_000);
		// tailStartIndex should equal headEndIndex (head consumes everything)
		expect(r.tailStartIndex).toBeLessThanOrEqual(r.headEndIndex);
	});

	it("HCP-03: long history → splits into [head, middle, tail]", () => {
		const hist = buildLongHistory(20, 200); // ~1000 tokens total, 50/msg
		const r = findHermesCutPoints(hist, 3, 300);
		expect(r.headEndIndex).toBe(3);
		expect(r.tailStartIndex).toBeGreaterThan(3);
		expect(r.tailStartIndex).toBeLessThan(hist.length);
		expect(r.middleTokens).toBeGreaterThan(0);
	});

	it("HCP-04: tail token budget respected", () => {
		const hist = buildLongHistory(20, 200);
		const r = findHermesCutPoints(hist, 3, 300);
		// tail tokens should be ≥ budget (or close to it)
		expect(r.tailTokens).toBeGreaterThanOrEqual(250);
	});
});

describe("hermes prompts", () => {
	it("HPR-01: preamble preserves Hermes language instruction", () => {
		expect(HERMES_SUMMARIZER_PREAMBLE).toMatch(
			/same language the user was using/,
		);
	});

	it("HPR-02: preamble has credential redaction rule", () => {
		expect(HERMES_SUMMARIZER_PREAMBLE).toMatch(/\[REDACTED\]/);
	});

	it("HPR-03: template has 12+ ## sections (Hermes structured format)", () => {
		const sections = HERMES_TEMPLATE_SECTIONS.match(/^## /gm) ?? [];
		// Hermes template has 12 top-level sections; embedded examples may
		// include extra `## ` lines (sub-examples). Accept ≥12.
		expect(sections.length).toBeGreaterThanOrEqual(12);
	});

	it("HPR-04: template includes Active Task as primary field", () => {
		expect(HERMES_TEMPLATE_SECTIONS).toMatch(/## Active Task/);
		expect(HERMES_TEMPLATE_SECTIONS).toMatch(/SINGLE MOST IMPORTANT FIELD/);
	});
});

describe("createHermesLLMMessagePrepareCompact", () => {
	it("HPC-01: empty history → undefined", async () => {
		const llm = mkLLMStub("Summary");
		const prepare = createHermesLLMMessagePrepareCompact({ llm });
		expect(await prepare([])).toBeUndefined();
	});

	it("HPC-02: small history (head overlaps tail) → undefined", async () => {
		const llm = mkLLMStub("Summary");
		const prepare = createHermesLLMMessagePrepareCompact({
			llm,
			tailTokenBudget: 1_000_000, // never reach
		});
		const hist = buildLongHistory(5, 100);
		expect(await prepare(hist)).toBeUndefined();
	});

	it("HPC-03: long history → calls LLM, returns [head, summary, tail]", async () => {
		const llm = mkLLMStub("## Active Task\nTest task");
		const prepare = createHermesLLMMessagePrepareCompact({
			llm,
			protectFirstN: 2,
			tailTokenBudget: 200,
		});
		const hist = buildLongHistory(20, 200);
		const result = await prepare(hist);
		expect(result).toBeDefined();
		expect(result!.length).toBeLessThan(hist.length);
		// head = first 2 messages (verbatim)
		expect(result![0]?.content).toBe(hist[0]!.content);
		expect(result![1]?.content).toBe(hist[1]!.content);
		// 3rd is the summary
		expect(typeof result![2]?.content).toBe("string");
		expect((result![2]?.content as string)).toMatch(/Hermes compacted summary/);
		expect((result![2]?.content as string)).toMatch(/Test task/);
		expect(llm.stream).toHaveBeenCalledOnce();
	});

	it("HPC-04: iterative — second call sends PREVIOUS SUMMARY", async () => {
		const llm = mkLLMStub("First Hermes summary");
		const prepare = createHermesLLMMessagePrepareCompact({
			llm,
			protectFirstN: 2,
			tailTokenBudget: 200,
		});
		await prepare(buildLongHistory(20, 200));
		await prepare(buildLongHistory(25, 200));

		const calls = (llm.stream as ReturnType<typeof vi.fn>).mock.calls;
		const secondReq = calls[1]?.[0] as { messages: LLMMessage[] };
		const userMsg = secondReq.messages[0]!;
		expect(userMsg.content).toMatch(/PREVIOUS SUMMARY:/);
		expect(userMsg.content).toMatch(/First Hermes summary/);
		expect(userMsg.content).toMatch(/updating a context compaction summary/);
	});

	it("HPC-05: focus topic adds FOCUS TOPIC section", async () => {
		const llm = mkLLMStub("Focused");
		const prepare = createHermesLLMMessagePrepareCompact({
			llm,
			protectFirstN: 2,
			tailTokenBudget: 200,
			focusTopic: "Korean fact retention",
		});
		await prepare(buildLongHistory(20, 200));

		const req = (llm.stream as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect((req.messages[0]!.content as string)).toMatch(
			/FOCUS TOPIC: "Korean fact retention"/,
		);
	});

	it("HPC-06: LLM error → undefined (graceful)", async () => {
		const llm = {
			generate: vi.fn(),
			stream: vi.fn(async function* () {
				throw new Error("LLM down");
				yield undefined as never;
			}),
		} as unknown as LLMClient;
		const prepare = createHermesLLMMessagePrepareCompact({
			llm,
			protectFirstN: 2,
			tailTokenBudget: 200,
		});
		const result = await prepare(buildLongHistory(20, 200));
		expect(result).toBeUndefined();
	});

	it("HPC-07: summary message role is 'user' (LLMRole limit)", async () => {
		const llm = mkLLMStub("Summary");
		const prepare = createHermesLLMMessagePrepareCompact({
			llm,
			protectFirstN: 2,
			tailTokenBudget: 200,
		});
		const result = await prepare(buildLongHistory(20, 200));
		expect(result![2]?.role).toBe("user");
	});
});
