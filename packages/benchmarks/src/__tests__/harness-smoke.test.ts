import { describe, expect, it } from "vitest";

import type { Fixture, FixtureResult, ProbeJudgement, LatencySample } from "../index.js";
import {
	driftScore,
	factRecall,
	latencyPercentiles,
	renderReport,
	runFixturePlaceholder,
	taskAccuracy,
	validateFixture,
} from "../index.js";

const validFixture: Fixture = {
	id: "T001-smoke",
	domain: "test",
	turns: [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello" },
	],
	probes: [
		{
			afterTurn: 1,
			type: "fact-recall",
			question: "who said hi?",
			expectedKeywords: ["user"],
		},
		// R7: validateFixture now requires at least one task-accuracy probe.
		{
			afterTurn: 1,
			type: "task-accuracy",
			question: "did the user greet?",
			criterion: "Response should mention greeting",
		},
	],
};

describe("validateFixture", () => {
	it("accepts a well-formed fixture", () => {
		expect(validateFixture(validFixture)).toBe(validFixture);
	});

	it("rejects non-object input", () => {
		expect(() => validateFixture(null)).toThrow(/must be an object/);
		expect(() => validateFixture("string")).toThrow(/must be an object/);
	});

	it("rejects missing id", () => {
		expect(() => validateFixture({ ...validFixture, id: "" })).toThrow(/id must be/);
	});

	it("rejects empty turns", () => {
		expect(() => validateFixture({ ...validFixture, turns: [] })).toThrow(/turns must be/);
	});

	it("rejects invalid role", () => {
		expect(() =>
			validateFixture({
				...validFixture,
				turns: [{ role: "robot", content: "..." }],
			}),
		).toThrow(/role invalid/);
	});

	it("rejects invalid probe type", () => {
		expect(() =>
			validateFixture({
				...validFixture,
				probes: [{ afterTurn: 0, type: "psychic-recall" }],
			}),
		).toThrow(/type invalid/);
	});
});

describe("metrics", () => {
	const probe: ProbeJudgement["probe"] = {
		afterTurn: 0,
		type: "fact-recall",
		question: "?",
		expectedKeywords: [],
	};

	it("taskAccuracy averages pass/fail", () => {
		const judgements: ProbeJudgement[] = [
			{ probe, response: "", pass: true },
			{ probe, response: "", pass: true },
			{ probe, response: "", pass: false },
		];
		expect(taskAccuracy(judgements)).toBeCloseTo(2 / 3);
	});

	it("taskAccuracy on empty input is 0", () => {
		expect(taskAccuracy([])).toBe(0);
	});

	it("factRecall filters to fact-recall probes", () => {
		const taskProbe: ProbeJudgement["probe"] = {
			afterTurn: 0,
			type: "task-accuracy",
			criterion: "...",
			question: "test?",
		};
		const judgements: ProbeJudgement[] = [
			{ probe, response: "", pass: true },
			{ probe: taskProbe, response: "", pass: false },
		];
		expect(factRecall(judgements)).toBe(1);
	});

	it("latencyPercentiles sorts and indexes", () => {
		const samples: LatencySample[] = Array.from({ length: 100 }, (_, i) => ({
			turnIdx: i,
			latencyMs: i + 1, // 1..100
			compaction: i === 50,
		}));
		const { p50, p99, compactionAvg } = latencyPercentiles(samples);
		expect(p50).toBe(51);
		expect(p99).toBe(100);
		expect(compactionAvg).toBe(51);
	});

	it("latencyPercentiles on empty input returns zeros", () => {
		expect(latencyPercentiles([])).toEqual({ p50: 0, p99: 0, compactionAvg: 0 });
	});

	it("driftScore is 1 for identical strings", () => {
		expect(driftScore("a b c", "a b c")).toBe(1);
	});

	it("driftScore is 0 for disjoint token sets", () => {
		expect(driftScore("alpha beta", "gamma delta")).toBe(0);
	});

	it("driftScore is Jaccard for partial overlap", () => {
		// "the quick fox" vs "the lazy fox": intersection={the,fox}=2, union={the,quick,fox,lazy}=4 → 0.5
		expect(driftScore("the quick fox", "the lazy fox")).toBeCloseTo(0.5);
	});
});

describe("runFixturePlaceholder", () => {
	it("returns a FixtureResult with the requested strategy and one stub error", () => {
		const r = runFixturePlaceholder(validFixture, "reactive");
		expect(r.fixtureId).toBe("T001-smoke");
		expect(r.strategy).toBe("reactive");
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatch(/placeholder/);
	});
});

describe("renderReport", () => {
	it("renders a non-empty markdown report with aggregate + per-fixture sections", () => {
		const results: FixtureResult[] = [
			{
				fixtureId: "T001-smoke",
				strategy: "reactive",
				taskAccuracy: 0.8,
				factRecall: 0.9,
				latencyP50Ms: 120,
				latencyP99Ms: 480,
				compactionLatencyMs: 2000,
				totalTokens: 50000,
				driftScore: 0.95,
				errors: [],
			},
			{
				fixtureId: "T001-smoke",
				strategy: "realtime",
				taskAccuracy: 0.85,
				factRecall: 0.92,
				latencyP50Ms: 130,
				latencyP99Ms: 200,
				compactionLatencyMs: 5,
				totalTokens: 52000,
				driftScore: 0.93,
				errors: [],
			},
		];
		const out = renderReport({
			date: "2026-05-20",
			fixtureCount: 1,
			strategiesUnderTest: ["reactive", "realtime"],
			results,
			judgeProfile: "none",
		});
		expect(out).toContain("# Compaction Benchmark — 2026-05-20");
		expect(out).toContain("## Aggregate");
		expect(out).toContain("## Per-fixture breakdown");
		expect(out).toContain("`reactive`");
		expect(out).toContain("`realtime`");
	});
});
