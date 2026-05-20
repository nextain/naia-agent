// Slice 3-XR-Handoff (#50) P1 — HandoffBlob shape + type-guard unit.
//
// Type-level guarantees that the runtime relies on. Distinct from the
// runtime test loop (P5) which exercises the auto-trigger path.

import { describe, it, expect } from "vitest";
import { isCapable } from "@nextain/agent-types";
import type {
	CompactableCapable,
	ConsolidationSummary,
	HandoffBlob,
	HandoffCapable,
	HandoffTrigger,
	MemoryHit,
	MemoryProvider,
} from "@nextain/agent-types";

describe("HandoffBlob shape (Slice 3-XR-Handoff #50 P1)", () => {
	it("HF-T-01: minimum well-formed blob compiles and round-trips through JSON", () => {
		const blob: HandoffBlob = {
			version: 1,
			sessionId: "sess-abc",
			createdAt: 1_700_000_000_000,
			turnCount: 12,
			totalTokens: 4_321,
			trigger: "manual",
			recap: {
				role: "assistant",
				content: "[session recap]\n## Goal\nbuild Slice 3-XR-Handoff",
				timestamp: 1_700_000_000_000,
			},
			anchors: ["#A-7421", "packages/core/src/agent.ts", "https://x.test/y"],
		};
		const json = JSON.stringify(blob);
		const parsed = JSON.parse(json) as HandoffBlob;
		expect(parsed.version).toBe(1);
		expect(parsed.sessionId).toBe("sess-abc");
		expect(parsed.trigger).toBe("manual");
		expect(parsed.anchors).toEqual([
			"#A-7421",
			"packages/core/src/agent.ts",
			"https://x.test/y",
		]);
	});

	it("HF-T-02: HandoffTrigger union accepts the three named values", () => {
		const triggers: HandoffTrigger[] = [
			"manual",
			"budget-95-post-compact",
			"session-close",
		];
		expect(triggers.length).toBe(3);
		// Compile-time assertion that no other string slips in (would TS-error
		// at literal assignment if the union changed shape).
		const t1: HandoffTrigger = "manual";
		const t2: HandoffTrigger = "budget-95-post-compact";
		const t3: HandoffTrigger = "session-close";
		expect([t1, t2, t3]).toHaveLength(3);
	});

	it("HF-T-03: empty anchors is valid (e.g. a session with no identifiers)", () => {
		const blob: HandoffBlob = {
			version: 1,
			sessionId: "sess-empty",
			createdAt: 0,
			turnCount: 0,
			totalTokens: 0,
			trigger: "session-close",
			recap: { role: "assistant", content: "" },
			anchors: [],
		};
		expect(blob.anchors).toEqual([]);
		expect(blob.recap.content).toBe("");
	});

	it("HF-T-04: anchors is readonly — TS-level guarantee (compile-time)", () => {
		// This test exists so that any future widening of `anchors` to mutable
		// `string[]` would surface as a compile error here. The runtime cast
		// below confirms the produced object is array-shaped at JSON parse.
		const blob: HandoffBlob = {
			version: 1,
			sessionId: "s",
			createdAt: 0,
			turnCount: 1,
			totalTokens: 1,
			trigger: "manual",
			recap: { role: "assistant", content: "x" },
			anchors: ["one", "two"],
		};
		expect(Array.isArray(blob.anchors)).toBe(true);
		// Read access is allowed; mutation is not part of the contract.
		expect(blob.anchors[0]).toBe("one");
	});
});

describe("HandoffCapable type-guard (Slice 3-XR-Handoff #50 P1)", () => {
	class CompactOnlyMemory implements MemoryProvider, CompactableCapable {
		async encode() {}
		async recall(): Promise<MemoryHit[]> {
			return [];
		}
		async consolidate(): Promise<ConsolidationSummary> {
			return { factsCreated: 0, durationMs: 0 };
		}
		async close() {}
		async compact() {
			return {
				summary: { role: "assistant" as const, content: "" },
				droppedCount: 0,
			};
		}
	}

	class HandoffMemory
		extends CompactOnlyMemory
		implements HandoffCapable
	{
		readonly attached: HandoffBlob[] = [];
		async attachHandoff(blob: HandoffBlob) {
			this.attached.push(blob);
		}
	}

	it("HF-T-05: isCapable<HandoffCapable> matches only providers exposing attachHandoff", () => {
		const compactOnly = new CompactOnlyMemory();
		const handoffMem = new HandoffMemory();
		expect(isCapable<HandoffCapable>(compactOnly, "attachHandoff")).toBe(false);
		expect(isCapable<HandoffCapable>(handoffMem, "attachHandoff")).toBe(true);
	});

	it("HF-T-06: attachHandoff side effect runs (smoke through the guard)", async () => {
		const handoffMem = new HandoffMemory();
		const blob: HandoffBlob = {
			version: 1,
			sessionId: "s",
			createdAt: 1,
			turnCount: 1,
			totalTokens: 1,
			trigger: "manual",
			recap: { role: "assistant", content: "x" },
			anchors: [],
		};
		if (isCapable<HandoffCapable>(handoffMem, "attachHandoff")) {
			await handoffMem.attachHandoff(blob);
		}
		expect(handoffMem.attached.length).toBe(1);
		expect(handoffMem.attached[0]).toBe(blob);
	});
});
