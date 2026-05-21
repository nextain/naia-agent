/**
 * R7 Phase A.2 (Claude audit F4 fix): unit tests for the SHARED
 * `buildVisibleContext` + `classifyProbeStress` functions. R6 demanded
 * a contract test that both call sites use the function identically;
 * Phase A wrote the function without one. Here it is.
 */

import { describe, expect, it } from "vitest";
import type { Fixture } from "../fixture.js";
import { classifyProbeStress } from "../fixture.js";
import { buildVisibleContext } from "../visible-context.js";

const baseFixture: Fixture = {
	id: "T-vc",
	domain: "test",
	turns: [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: "a1" },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: "a2" },
		{ role: "user", content: "u3" },
		{ role: "assistant", content: "a3" },
		{ role: "user", content: "u4" },
		{ role: "assistant", content: "a4" },
	],
	probes: [
		{
			afterTurn: 8,
			type: "task-accuracy",
			question: "q?",
			criterion: "c",
		},
	],
	compactionPoints: [4],
};

describe("buildVisibleContext", () => {
	it("BVC-01: off strategy = full transcript, no recap header", () => {
		const out = buildVisibleContext({
			fixture: baseFixture,
			strategy: "off",
			currentTurn: 8,
			recapContent: "RECAP TEXT",
			keepTail: 2,
			contextWindowChars: 0,
		});
		expect(out.wasCompacted).toBe(false);
		expect(out.visible.includes("[recap]")).toBe(false);
		expect(out.visible.includes("u1")).toBe(true);
		expect(out.visible.includes("a4")).toBe(true);
	});

	it("BVC-02: reactive with compaction → [recap] + [tail], tail starts at lastCompactionPoint - keepTail", () => {
		const out = buildVisibleContext({
			fixture: baseFixture,
			strategy: "reactive",
			currentTurn: 8,
			recapContent: "RECAP TEXT",
			keepTail: 2,
			contextWindowChars: 0,
		});
		expect(out.wasCompacted).toBe(true);
		expect(out.lastCompactionPoint).toBe(4);
		expect(out.tailRange).toEqual({ start: 2, end: 8 });
		expect(out.visible.includes("[recap]")).toBe(true);
		expect(out.visible.includes("RECAP TEXT")).toBe(true);
		expect(out.visible.includes("[tail]")).toBe(true);
		// turns 0..1 (u1, a1) NOT in tail
		// turns 2..7 (u2..a4) IN tail
		expect(out.visible.includes("u2")).toBe(true);
		expect(out.visible.includes("a4")).toBe(true);
	});

	it("BVC-03: empty recap is honest — visible is recap header + tail (no full-transcript fallback)", () => {
		const out = buildVisibleContext({
			fixture: baseFixture,
			strategy: "reactive-vercel",
			currentTurn: 8,
			recapContent: "",
			keepTail: 2,
			contextWindowChars: 0,
		});
		expect(out.visible.includes("[recap]\n\n\n")).toBe(true); // empty recap between headers
		// turns 0..1 still NOT in visible — no silent fallback to full transcript
		expect(out.visible.includes("u1")).toBe(false);
		expect(out.visible.includes("u2")).toBe(true); // tail starts at 2
	});

	it("BVC-04: tailStart clamps at 0 when keepTail > lastCompactionPoint", () => {
		const fx: Fixture = { ...baseFixture, compactionPoints: [1] };
		const out = buildVisibleContext({
			fixture: fx,
			strategy: "reactive",
			currentTurn: 8,
			recapContent: "R",
			keepTail: 5,
			contextWindowChars: 0,
		});
		expect(out.tailRange.start).toBe(0); // max(0, 1-5) = 0
	});

	it("BVC-05: context-window cap applies right-aligned with role-prefix boundary", () => {
		const longFx: Fixture = {
			...baseFixture,
			turns: Array.from({ length: 20 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant" as const,
				content: "x".repeat(60),
			})),
			probes: [
				{ afterTurn: 20, type: "task-accuracy", question: "q", criterion: "c" },
			],
			compactionPoints: [],
		};
		const out = buildVisibleContext({
			fixture: longFx,
			strategy: "off",
			currentTurn: 20,
			recapContent: "",
			keepTail: 2,
			contextWindowChars: 200,
		});
		expect(out.capApplied).toBe(true);
		expect(out.visible.length).toBeLessThan(400); // cap + truncation prefix
		expect(out.visible.startsWith("[context truncated")).toBe(true);
	});

	it("BVC-06: cap=0 disables the cap (drift baseline use case)", () => {
		const longFx: Fixture = {
			...baseFixture,
			turns: Array.from({ length: 20 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant" as const,
				content: "x".repeat(200),
			})),
			compactionPoints: [],
		};
		const out = buildVisibleContext({
			fixture: longFx,
			strategy: "off",
			currentTurn: 20,
			recapContent: "",
			keepTail: 2,
			contextWindowChars: 0,
		});
		expect(out.capApplied).toBe(false);
		expect(out.visible.length).toBeGreaterThan(3000);
	});

	it("BVC-07: no compactionPoint yet → wasCompacted=false even for reactive", () => {
		const fx: Fixture = { ...baseFixture, compactionPoints: [] };
		const out = buildVisibleContext({
			fixture: fx,
			strategy: "reactive",
			currentTurn: 8,
			recapContent: "R",
			keepTail: 2,
			contextWindowChars: 0,
		});
		expect(out.wasCompacted).toBe(false);
		expect(out.lastCompactionPoint).toBeUndefined();
	});

	it("BVC-08: contract — runner and mini-bench currentTurn must agree (callers' responsibility)", () => {
		// When mini-bench uses probe.afterTurn=8 and runner uses
		// fixture.turns.length=8, both should produce the same visible.
		const minibench = buildVisibleContext({
			fixture: baseFixture,
			strategy: "reactive",
			currentTurn: 8,
			recapContent: "R",
			keepTail: 2,
			contextWindowChars: 0,
		});
		const runner = buildVisibleContext({
			fixture: baseFixture,
			strategy: "reactive",
			currentTurn: baseFixture.turns.length,
			recapContent: "R",
			keepTail: 2,
			contextWindowChars: 0,
		});
		expect(minibench.visible).toBe(runner.visible);
	});
});

describe("classifyProbeStress", () => {
	it("CPS-01: no compactionPoint → no-compaction", () => {
		expect(classifyProbeStress([1, 2], undefined, 2)).toBe("no-compaction");
	});

	it("CPS-02: empty factTurns → unclassified", () => {
		expect(classifyProbeStress([], 10, 2)).toBe("unclassified");
		expect(classifyProbeStress(undefined, 10, 2)).toBe("unclassified");
	});

	it("CPS-03: all factTurns ≤ tailStart → recap-only", () => {
		// lastCompactionPoint=10, keepTail=2 → tailStart = 8
		expect(classifyProbeStress([3, 5, 7], 10, 2)).toBe("recap-only");
		expect(classifyProbeStress([8], 10, 2)).toBe("recap-only"); // exactly at boundary
	});

	it("CPS-04: any factTurn > tailStart → tail-trivial", () => {
		// tailStart = 8
		expect(classifyProbeStress([9], 10, 2)).toBe("tail-trivial");
		expect(classifyProbeStress([3, 5, 9], 10, 2)).toBe("tail-trivial"); // mixed → tail-trivial (conservative)
	});

	it("CPS-05: keepTail=0 → tailStart = lastCompactionPoint (no preserved tail)", () => {
		// factTurn=10, tailStart=max(0, 10-0)=10. 10 > 10 is false → recap-only.
		expect(classifyProbeStress([10], 10, 0)).toBe("recap-only");
		expect(classifyProbeStress([11], 10, 0)).toBe("tail-trivial");
	});
});
