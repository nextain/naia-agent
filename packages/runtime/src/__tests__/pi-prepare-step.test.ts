/**
 * pi-prepare-step.ts unit tests — R8 Slice 3-XR-Compact v2 #56.
 *
 * Tests cover: token estimation, cut-point finding, anchored-iterative
 * summary call, no-op rejection (history too short / empty summary / LLM error).
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMClient, LLMStreamChunk } from "@nextain/agent-core";
import type { LLMMessage } from "@nextain/agent-types";
import {
	createPiLLMMessagePrepareCompact,
	estimateMessageTokens,
	findCutPoint,
	PI_SUMMARIZATION_PROMPT,
	PI_SUMMARIZATION_SYSTEM_PROMPT,
	PI_UPDATE_SUMMARIZATION_PROMPT,
} from "../compaction/pi-prepare-step.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function mkMsg(role: LLMMessage["role"], text: string): LLMMessage {
	return { role, content: text };
}

/** Build a long-enough history so `findCutPoint` produces a non-zero cut. */
function buildLongHistory(n: number, charsPerMsg: number): LLMMessage[] {
	return Array.from({ length: n }, (_, i) =>
		mkMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMsg)),
	);
}

function mkLLMStub(summaryText: string): LLMClient {
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
				delta: { type: "text_delta", text: summaryText },
			};
			yield { type: "content_block_stop", index: 0 };
			yield {
				type: "end",
				stopReason: "stop",
				usage: {
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
			};
		}),
	} as unknown as LLMClient;
}

function mkLLMErrorStub(): LLMClient {
	return {
		generate: vi.fn(),
		stream: vi.fn(async function* () {
			throw new Error("LLM unavailable");
			yield undefined as never;
		}),
	} as unknown as LLMClient;
}

// ─── token estimation ─────────────────────────────────────────────────────────

describe("estimateMessageTokens", () => {
	it("ETM-01: string content = ceil(chars/4)", () => {
		// "hello world" = 11 chars → ceil(11/4) = 3
		expect(estimateMessageTokens(mkMsg("user", "hello world"))).toBe(3);
	});

	it("ETM-02: empty string = 0", () => {
		expect(estimateMessageTokens(mkMsg("user", ""))).toBe(0);
	});

	it("ETM-03: long string scales", () => {
		expect(estimateMessageTokens(mkMsg("assistant", "x".repeat(400)))).toBe(100);
	});

	it("ETM-04: text block in content array", () => {
		const msg: LLMMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
		};
		expect(estimateMessageTokens(msg)).toBe(2);
	});

	it("ETM-05: tool_use block counts name + JSON.stringify(input)", () => {
		const msg: LLMMessage = {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "id1",
					name: "shell",
					input: { cmd: "ls" },
				},
			],
		};
		// "shell" (5) + JSON '{"cmd":"ls"}' (12) = 17 → ceil(17/4) = 5
		expect(estimateMessageTokens(msg)).toBe(5);
	});

	it("ETM-06: image block = 4800 chars (pi's per-image budget)", () => {
		const msg: LLMMessage = {
			role: "user",
			content: [
				{
					type: "image",
					source: { type: "base64", mediaType: "image/png", data: "AAA" },
				},
			],
		};
		// 4800 → ceil(4800/4) = 1200
		expect(estimateMessageTokens(msg)).toBe(1200);
	});
});

// ─── cut-point finding ────────────────────────────────────────────────────────

describe("findCutPoint", () => {
	it("FCP-01: empty history → cutIndex=0", () => {
		const r = findCutPoint([], 1000);
		expect(r.cutIndex).toBe(0);
		expect(r.tokensInKept).toBe(0);
		expect(r.tokensInSummarize).toBe(0);
	});

	it("FCP-02: history smaller than keep → cutIndex=0 (no compaction)", () => {
		const hist = buildLongHistory(5, 40); // ~10 tokens each = 50 total
		const r = findCutPoint(hist, 1000);
		expect(r.cutIndex).toBe(0);
	});

	it("FCP-03: history larger than keep → cuts to leave ~keep tokens", () => {
		// 20 msgs × 200 chars = ~50 tokens each = 1000 total
		const hist = buildLongHistory(20, 200);
		const r = findCutPoint(hist, 300);
		// kept should be ≥300 tokens, summarize is the rest
		expect(r.cutIndex).toBeGreaterThan(0);
		expect(r.cutIndex).toBeLessThan(hist.length);
		expect(r.tokensInKept).toBeGreaterThanOrEqual(300 - 50); // ±1 msg
	});

	it("FCP-04: cuts at user-message boundary (turn start) when possible", () => {
		// alternating user/assistant; cut should land on user
		const hist = buildLongHistory(20, 200);
		const r = findCutPoint(hist, 300);
		if (r.cutIndex < hist.length) {
			expect(hist[r.cutIndex]?.role).toBe("user");
		}
	});
});

// ─── prompts (license-preserved verbatim from pi-mono) ────────────────────────

describe("pi prompts", () => {
	it("PRP-01: SUMMARIZATION_SYSTEM_PROMPT mentions structured summary", () => {
		expect(PI_SUMMARIZATION_SYSTEM_PROMPT).toMatch(/structured summary/);
	});

	it("PRP-02: SUMMARIZATION_PROMPT has 5-section headers", () => {
		for (const header of [
			"## Goal",
			"## Constraints & Preferences",
			"## Progress",
			"## Key Decisions",
			"## Next Steps",
			"## Critical Context",
		]) {
			expect(PI_SUMMARIZATION_PROMPT).toContain(header);
		}
	});

	it("PRP-03: UPDATE_SUMMARIZATION_PROMPT explicit preservation rule", () => {
		expect(PI_UPDATE_SUMMARIZATION_PROMPT).toMatch(/PRESERVE/);
	});
});

// ─── adapter behavior ─────────────────────────────────────────────────────────

describe("createPiLLMMessagePrepareCompact", () => {
	it("PCP-01: empty history → undefined (no-op)", async () => {
		const llm = mkLLMStub("Summary X");
		const prepare = createPiLLMMessagePrepareCompact({ llm });
		expect(await prepare([])).toBeUndefined();
	});

	it("PCP-02: history too short to cut → undefined", async () => {
		const llm = mkLLMStub("Summary X");
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 1_000_000, // never reach
		});
		const hist = buildLongHistory(10, 100);
		expect(await prepare(hist)).toBeUndefined();
	});

	it("PCP-03: long history → calls LLM, replaces with [summary, ...kept]", async () => {
		const llm = mkLLMStub("## Goal\nTest summary");
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 200,
		});
		const hist = buildLongHistory(20, 200); // ~1000 tokens total
		const result = await prepare(hist);
		expect(result).toBeDefined();
		expect(result!.length).toBeLessThan(hist.length);
		// First message is the summary
		expect(typeof result![0]?.content).toBe("string");
		expect((result![0]?.content as string)).toMatch(/\[Compacted summary/);
		expect((result![0]?.content as string)).toMatch(/Test summary/);
		expect(llm.stream).toHaveBeenCalledOnce();
	});

	it("PCP-04: LLM error → undefined (graceful skip)", async () => {
		const llm = mkLLMErrorStub();
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 200,
		});
		const hist = buildLongHistory(20, 200);
		const result = await prepare(hist);
		expect(result).toBeUndefined();
	});

	it("PCP-05: empty summary → undefined", async () => {
		const llm = mkLLMStub("   "); // whitespace-only
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 200,
		});
		const hist = buildLongHistory(20, 200);
		const result = await prepare(hist);
		expect(result).toBeUndefined();
	});

	it("PCP-06: iterative — second call sends previous summary in <previous-summary>", async () => {
		const llm1 = mkLLMStub("First summary text");
		const prepare = createPiLLMMessagePrepareCompact({
			llm: llm1,
			keepRecentTokens: 200,
		});
		const hist1 = buildLongHistory(20, 200);
		await prepare(hist1);

		// Second call — check the prompt includes <previous-summary>
		const hist2 = buildLongHistory(25, 200);
		await prepare(hist2);

		// Inspect the second LLM call's user message
		const calls = (llm1.stream as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBe(2);
		const secondCallReq = calls[1]?.[0];
		const userMsg = secondCallReq.messages[0];
		expect(userMsg.content).toMatch(/<previous-summary>/);
		expect(userMsg.content).toMatch(/First summary text/);
		// UPDATE prompt is used on iteration
		expect(userMsg.content).toMatch(/UPDATE the Progress section/);
	});

	it("PCP-07: focus topic added to prompt suffix", async () => {
		const llm = mkLLMStub("Focused summary");
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 200,
			focusTopic: "naia-memory integration",
		});
		const hist = buildLongHistory(20, 200);
		await prepare(hist);

		const userMsg = (llm.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
			.messages[0];
		expect(userMsg.content).toMatch(/Additional focus: naia-memory integration/);
	});

	it("PCP-08: LLM call uses SUMMARIZATION_SYSTEM_PROMPT as system", async () => {
		const llm = mkLLMStub("Summary");
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 200,
		});
		await prepare(buildLongHistory(20, 200));

		const req = (llm.stream as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(req.system).toBe(PI_SUMMARIZATION_SYSTEM_PROMPT);
	});

	it("PCP-09: summary message has 'user' role (LLMRole limit, system→user)", async () => {
		const llm = mkLLMStub("Summary");
		const prepare = createPiLLMMessagePrepareCompact({
			llm,
			keepRecentTokens: 200,
		});
		const result = await prepare(buildLongHistory(20, 200));
		expect(result![0]?.role).toBe("user");
	});
});
