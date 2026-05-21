// Slice 3-XR-Compact v2 / Phase 1 (#56) — Vercel AI SDK prepareStep adoption.
//
// Unit tests for the helper that wraps `pruneMessages` into a prepareStep
// callback. We test the THRESHOLD logic, the observability callback, and
// the fact that we DON'T mutate when below threshold. We do NOT test
// `pruneMessages` itself — that's covered by ai-sdk's own test suite
// (`ref-vercel-ai-sdk/packages/ai/src/generate-text/prune-messages.test.ts`).

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
	createVercelCompactionPrepareStep,
	defaultEstimateTokens,
} from "../compaction/vercel-prepare-step.js";

const LONG_MESSAGE: ModelMessage = {
	role: "user",
	// 가짜 긴 message — chars/4 estimator 가 임계값 초과하도록.
	content: "x".repeat(800_000),
};

const SHORT_MESSAGE: ModelMessage = {
	role: "user",
	content: "안녕하세요",
};

describe("createVercelCompactionPrepareStep (Slice v2 / #56)", () => {
	it("VPS-01: returns undefined when below threshold (no mutation)", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
		});
		const result = prepare({ messages: [SHORT_MESSAGE] });
		expect(result).toBeUndefined();
	});

	it("VPS-02: returns { messages: pruned } when above threshold", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
		});
		const result = prepare({ messages: [LONG_MESSAGE] });
		expect(result).toBeDefined();
		expect(result!.messages).toBeDefined();
		expect(Array.isArray(result!.messages)).toBe(true);
	});

	it("VPS-03: onCompact callback fires only when compaction triggers", () => {
		const onCompact = vi.fn();
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
			onCompact,
		});

		prepare({ messages: [SHORT_MESSAGE] });
		expect(onCompact).not.toHaveBeenCalled();

		prepare({ messages: [LONG_MESSAGE] });
		expect(onCompact).toHaveBeenCalledTimes(1);
		const [info] = onCompact.mock.calls[0]!;
		expect(info.beforeTokens).toBeGreaterThan(100_000);
		expect(typeof info.messagesBefore).toBe("number");
		expect(typeof info.messagesAfter).toBe("number");
	});

	it("VPS-04: custom estimator override is used", () => {
		const customEstimator = vi.fn().mockReturnValue(999_999);
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
			estimateTokens: customEstimator,
		});
		const result = prepare({ messages: [SHORT_MESSAGE] });
		expect(customEstimator).toHaveBeenCalledTimes(1);
		// 999_999 > 100_000 → compaction fires even though message is short
		expect(result).toBeDefined();
	});

	it("VPS-05: defaultEstimateTokens uses chars/4 heuristic (matches cookbook)", () => {
		const msg: ModelMessage = { role: "user", content: "1234" };
		// JSON.stringify([{role:"user",content:"1234"}]) ≈ 28-30 chars / 4 ≈ 7
		const tokens = defaultEstimateTokens([msg]);
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(10);
	});

	it("VPS-06: empty messages returns undefined (no compaction needed)", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
		});
		const result = prepare({ messages: [] });
		expect(result).toBeUndefined();
	});

	it("VPS-07: default threshold is 100_000 (matches cookbook)", () => {
		const onCompact = vi.fn();
		const prepare = createVercelCompactionPrepareStep({ onCompact });
		// 800k char message → chars/4 ≈ 200k tokens > 100k → fires
		prepare({ messages: [LONG_MESSAGE] });
		expect(onCompact).toHaveBeenCalled();
	});

	it("VPS-08: stepNumber + initialMessages params are received (cookbook signature)", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
		});
		// Should not throw even when full signature is passed
		expect(() =>
			prepare({
				messages: [SHORT_MESSAGE],
				initialMessages: [SHORT_MESSAGE],
				responseMessages: [],
				stepNumber: 0,
			}),
		).not.toThrow();
	});
});
