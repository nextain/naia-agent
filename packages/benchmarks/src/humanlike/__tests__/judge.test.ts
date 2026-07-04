import { describe, expect, it } from "vitest";
import {
	aggregateSocialQuality,
	buildSocialQualityPrompt,
	median,
	medianAxes,
	parseSocialQualityReply,
	SOCIAL_QUALITY_PASS_THRESHOLD,
	type ScoredJudgeResult,
	type SocialQualityVerdict,
} from "../judge.js";

const input = {
	trigger: "주말 식당 추천해줘",
	response: "너 채식하니까 채식 메뉴 있는 곳으로 추천할게",
	expectedMemory: ["채식"],
	acceptableStyle: "자연스럽게",
	forbiddenRecalls: ["마파두부"],
};

describe("buildSocialQualityPrompt", () => {
	it("includes trigger, response, expected memory, style, and forbidden set", () => {
		const p = buildSocialQualityPrompt(input);
		expect(p).toContain("주말 식당 추천해줘");
		expect(p).toContain("너 채식하니까");
		expect(p).toContain("채식");
		expect(p).toContain("자연스럽게");
		expect(p).toContain("마파두부");
		expect(p).toMatch(/APPROPRIATENESS: <0-3>/);
	});
	it("omits optional sections when absent", () => {
		const p = buildSocialQualityPrompt({ trigger: "t", response: "r", expectedMemory: ["m"] });
		expect(p).not.toContain("ACCEPTABLE STYLE");
		expect(p).not.toContain("INAPPROPRIATE TO SURFACE");
	});
	it("grounds faithfulness on recalledMemory when provided, else falls back to expectedMemory", () => {
		const withRecalled = buildSocialQualityPrompt({ trigger: "t", response: "r", expectedMemory: ["채식"], recalledMemory: ["마파두부가 최애", "채식 중"] });
		expect(withRecalled).toContain("마파두부가 최애 | 채식 중");
		const fallback = buildSocialQualityPrompt({ trigger: "t", response: "r", expectedMemory: ["채식"] });
		expect(fallback).toMatch(/RECALLED MEMORY[^\n]*채식/);
	});
});

describe("parseSocialQualityReply", () => {
	it("parses a clean 4-line reply", () => {
		const v = parseSocialQualityReply(
			"APPROPRIATENESS: 3\nNATURALNESS: 2\nFAITHFULNESS: 3\nREASON: reflected the veg preference naturally",
			42,
		);
		expect(v).not.toBeNull();
		expect(v!.axes).toEqual({ appropriateness: 3, naturalness: 2, faithfulness: 3 });
		expect(v!.reason).toContain("veg preference");
		expect(v!.latencyMs).toBe(42);
	});
	it("tolerates surrounding prose and '=' separators", () => {
		const v = parseSocialQualityReply("Here is my rating.\nAppropriateness = 2\nnaturalness: 1\nFAITHFULNESS=3\nreason: ok", 0);
		expect(v!.axes).toEqual({ appropriateness: 2, naturalness: 1, faithfulness: 3 });
	});
	it("returns null when any axis is missing", () => {
		expect(parseSocialQualityReply("APPROPRIATENESS: 3\nNATURALNESS: 2\nREASON: no faithfulness", 0)).toBeNull();
	});
	it("returns null on out-of-range / malformed scores", () => {
		expect(parseSocialQualityReply("APPROPRIATENESS: 5\nNATURALNESS: 2\nFAITHFULNESS: 3", 0)).toBeNull();
	});
});

describe("median / medianAxes", () => {
	it("odd count → middle; even count → mean of two middles", () => {
		expect(median([2])).toBe(2);
		expect(median([1, 3, 2])).toBe(2);
		expect(median([2, 3])).toBe(2.5);
		expect(median([0, 1, 2, 3])).toBe(1.5);
	});
	it("medianAxes takes the per-axis median independently", () => {
		const v = (a: number, n: number, f: number): SocialQualityVerdict => ({ axes: { appropriateness: a, naturalness: n, faithfulness: f }, reason: "", latencyMs: 0 });
		expect(medianAxes([v(3, 1, 2), v(1, 3, 2), v(2, 2, 0)])).toEqual({ appropriateness: 2, naturalness: 2, faithfulness: 2 });
	});
});

describe("aggregateSocialQuality", () => {
	const verdict = (a: number, n: number, f: number): ScoredJudgeResult => ({ axes: { appropriateness: a, naturalness: n, faithfulness: f }, reason: "r", latencyMs: 1 });

	it("passes when overall (mean of axis-medians) ≥ threshold", () => {
		const agg = aggregateSocialQuality({ codex: verdict(3, 2, 3), claude: verdict(2, 3, 2) });
		// axis-medians: appropriateness 2.5, naturalness 2.5, faithfulness 2.5 → overall 2.5
		expect(agg.axes).toEqual({ appropriateness: 2.5, naturalness: 2.5, faithfulness: 2.5 });
		expect(agg.overall).toBeCloseTo(2.5);
		expect(agg.pass).toBe(true);
		expect(agg.validCount).toBe(2);
	});
	it("fails below threshold", () => {
		const agg = aggregateSocialQuality({ codex: verdict(1, 1, 2), claude: verdict(1, 2, 1) });
		expect(agg.overall).toBeLessThan(SOCIAL_QUALITY_PASS_THRESHOLD);
		expect(agg.pass).toBe(false);
	});
	it("excludes infra-errored judges from the vote", () => {
		const agg = aggregateSocialQuality({ codex: verdict(3, 3, 3), claude: { infraError: "cli missing", latencyMs: 0 } });
		expect(agg.validCount).toBe(1);
		expect(agg.infraErrorCount).toBe(1);
		expect(agg.pass).toBe(true); // codex-only median
	});
	it("marks unreliable + fail when all judges hit infra errors", () => {
		const agg = aggregateSocialQuality({ codex: { infraError: "x", latencyMs: 0 }, claude: { infraError: "y", latencyMs: 0 } });
		expect(agg.unreliable).toBe(true);
		expect(agg.pass).toBe(false);
		expect(agg.validCount).toBe(0);
	});
});
