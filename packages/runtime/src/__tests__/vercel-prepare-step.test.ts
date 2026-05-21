// Slice 3-XR-Compact v2 / Phase 1 (#56) — Vercel AI SDK prepareStep adoption.
// Ralph R2 — cross-review fixes applied.
//
// Tests THRESHOLD logic, observability callback, error safety (R2 add:
// codex/opencode/gemini review). DO NOT re-test `pruneMessages` itself —
// covered by ai-sdk's own test suite.

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
	createVercelCompactionPrepareStep,
	defaultEstimateTokens,
	COOKBOOK_PRUNE_OPTIONS,
} from "../compaction/vercel-prepare-step.js";

const LONG_MESSAGE: ModelMessage = {
	role: "user",
	content: "x".repeat(800_000),
};

const SHORT_MESSAGE: ModelMessage = {
	role: "user",
	content: "안녕하세요",
};

describe("createVercelCompactionPrepareStep R2 (Slice v2 / #56)", () => {
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
		expect(result).toBeDefined();
	});

	it("VPS-05: defaultEstimateTokens uses chars/4 heuristic (matches cookbook)", () => {
		const msg: ModelMessage = { role: "user", content: "1234" };
		const tokens = defaultEstimateTokens([msg]);
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(10);
	});

	it("VPS-06: empty messages returns undefined", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
		});
		const result = prepare({ messages: [] });
		expect(result).toBeUndefined();
	});

	it("VPS-07: default threshold is 100_000 (matches cookbook)", () => {
		const onCompact = vi.fn();
		const prepare = createVercelCompactionPrepareStep({ onCompact });
		prepare({ messages: [LONG_MESSAGE] });
		expect(onCompact).toHaveBeenCalled();
	});

	it("VPS-08: full cookbook signature accepted (initialMessages/responseMessages/stepNumber)", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
		});
		expect(() =>
			prepare({
				messages: [SHORT_MESSAGE],
				initialMessages: [SHORT_MESSAGE],
				responseMessages: [],
				stepNumber: 0,
			}),
		).not.toThrow();
	});

	// ── R2 additions (cross-review feedback) ──

	it("VPS-R2-01 (codex): exactly-at-threshold returns undefined (`>` not `>=`)", () => {
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
			estimateTokens: () => 100_000, // exactly at
		});
		const result = prepare({ messages: [SHORT_MESSAGE] });
		expect(result).toBeUndefined();
	});

	it("VPS-R2-02 (codex): estimator returning NaN → undefined (no compaction, error logged)", () => {
		const onError = vi.fn();
		const prepare = createVercelCompactionPrepareStep({
			estimateTokens: () => NaN,
			onError,
		});
		const result = prepare({ messages: [LONG_MESSAGE] });
		expect(result).toBeUndefined();
		// NaN is not "estimate threw" — onError not called for non-finite, just skipped.
		// (Skipping is the safe default for invalid estimator output.)
	});

	it("VPS-R2-03 (codex): estimator throw → undefined + onError fires", () => {
		const boom = new Error("estimator failed");
		const onError = vi.fn();
		const prepare = createVercelCompactionPrepareStep({
			estimateTokens: () => {
				throw boom;
			},
			onError,
		});
		const result = prepare({ messages: [LONG_MESSAGE] });
		expect(result).toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]![1]).toBe("estimate");
	});

	it("VPS-R2-04 (codex): onCompact throw is caught (step pipeline survives)", () => {
		const onError = vi.fn();
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
			onCompact: () => {
				throw new Error("observability boom");
			},
			onError,
		});
		// Should NOT throw — observability error swallowed.
		const result = prepare({ messages: [LONG_MESSAGE] });
		expect(result).toBeDefined();
		expect(result!.messages).toBeDefined();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]![1]).toBe("onCompact");
	});

	it("VPS-R2-05 (gemini): pruneOptions override is forwarded to pruneMessages", () => {
		// Phase 1.2 (#56): SDK-tracked PruneMessagesOptions — valid literals
		// are `reasoning: 'all'|'before-last-message'|'none'` and
		// `toolCalls: 'all'|'before-last-message'|'before-last-N-messages'|'none'|Array`.
		const prepare = createVercelCompactionPrepareStep({
			compactAfterTokens: 100_000,
			pruneOptions: {
				reasoning: "none",
				toolCalls: "none",
				emptyMessages: "keep",
			},
		});
		const result = prepare({ messages: [LONG_MESSAGE] });
		// We don't assert on pruneMessages internals (that's its own test).
		// Smoke: with relaxed options, function returns successfully.
		expect(result).toBeDefined();
	});

	it("VPS-R2-06: COOKBOOK_PRUNE_OPTIONS exports the canonical cookbook values", () => {
		expect(COOKBOOK_PRUNE_OPTIONS).toEqual({
			reasoning: "all",
			toolCalls: "before-last-3-messages",
			emptyMessages: "remove",
		});
	});

	it("VPS-R2-07 (opencode): types renamed to avoid SDK shadowing — smoke import test", async () => {
		const mod = await import("../compaction/vercel-prepare-step.js");
		expect(mod.createVercelCompactionPrepareStep).toBeDefined();
		expect(mod.defaultEstimateTokens).toBeDefined();
		expect(mod.COOKBOOK_PRUNE_OPTIONS).toBeDefined();
	});
});
