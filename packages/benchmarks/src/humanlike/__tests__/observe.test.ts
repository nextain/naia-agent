import { describe, expect, it } from "vitest";
import { buildTrace, isDegenerateResponse, type ProbeObservation } from "../observe.js";
import { classifyPipeline } from "../pipeline.js";

// Trivial containment for the pure mapping test — Korean-aware matching is the
// runtime judge's job (unit-tested there); here we only prove obs → trace.
const contains = (h: string, n: string) => h.includes(n);

const obs = (over: Partial<ProbeObservation>): ProbeObservation => ({
	probeId: "P",
	markerEmitted: false,
	markerDrivenHits: [],
	responseText: "",
	...over,
});

const probe = { expectedMemorySet: ["채식"], forbiddenRecalls: ["마파두부"] };

describe("buildTrace — observation → deterministic trace", () => {
	it("marker emitted maps to recallAttempted", () => {
		const t = buildTrace(obs({ markerEmitted: true }), probe, contains);
		expect(t.recallAttempted).toBe(true);
	});

	it("targetRetrieved iff a marker-driven hit contains an expected anchor", () => {
		expect(
			buildTrace(obs({ markerDrivenHits: ["나는 채식 중이다"] }), probe, contains)
				.targetRetrieved,
		).toBe(true);
		expect(
			buildTrace(obs({ markerDrivenHits: ["오늘 야근했다"] }), probe, contains)
				.targetRetrieved,
		).toBe(false);
	});

	it("targetUsed iff the response contains an expected anchor", () => {
		expect(
			buildTrace(obs({ responseText: "채식 메뉴 있는 곳 추천할게" }), probe, contains)
				.targetUsed,
		).toBe(true);
		expect(
			buildTrace(obs({ responseText: "아무 데나 가자" }), probe, contains).targetUsed,
		).toBe(false);
	});

	it("forbiddenSurfaced iff the response contains a forbidden anchor", () => {
		expect(
			buildTrace(obs({ responseText: "마파두부 잘하는 집 어때" }), probe, contains)
				.forbiddenSurfaced,
		).toBe(true);
	});

	it("passes responseText through verbatim for the judge layer", () => {
		const t = buildTrace(obs({ responseText: "hello" }), probe, contains);
		expect(t.responseText).toBe("hello");
	});
});

describe("isDegenerateResponse — execution-failure guard", () => {
	it("flags empty / whitespace responses", () => {
		expect(isDegenerateResponse("")).toBe(true);
		expect(isDegenerateResponse("   \n ")).toBe(true);
	});
	it("flags agent stop/abort/halt stubs", () => {
		expect(isDegenerateResponse("[agent stopped — reached max tool-hop budget]")).toBe(true);
		expect(isDegenerateResponse("[agent aborted]")).toBe(true);
		expect(isDegenerateResponse("[agent halted — 3 consecutive tool errors]")).toBe(true);
	});
	it("does not flag a real answer", () => {
		expect(isDegenerateResponse("채식 메뉴 있는 곳으로 추천할게")).toBe(false);
	});
});

describe("buildTrace → classifyPipeline (end-to-end deterministic path)", () => {
	it("positive: clean use → used-needs-judge", () => {
		const t = buildTrace(
			obs({
				markerEmitted: true,
				markerDrivenHits: ["나는 채식 중이다"],
				responseText: "채식 메뉴 있는 식당 추천할게",
			}),
			probe,
			contains,
		);
		expect(classifyPipeline(t, "positive").bucket).toBe("used-needs-judge");
	});

	it("positive: no marker but response happens to mention anchor → still no-recall-attempt (decision failure)", () => {
		// Isolation guarantees the anchor could not have reached the model via
		// start-of-turn recall, so a used anchor without a marker is an
		// agent-DECISION artifact, not a memory pass. Attribution stays honest.
		const t = buildTrace(
			obs({ markerEmitted: false, responseText: "채식 얘기" }),
			probe,
			contains,
		);
		expect(classifyPipeline(t, "positive").bucket).toBe("no-recall-attempt");
	});

	it("negative: dragged the preference into a condolence context → forced-inappropriate", () => {
		const t = buildTrace(
			obs({
				markerEmitted: true,
				markerDrivenHits: ["나는 채식 중이다"],
				responseText: "그래도 채식 식단이라도 챙겨 먹어",
			}),
			probe,
			contains,
		);
		expect(classifyPipeline(t, "negative").bucket).toBe("forced-inappropriate");
		expect(classifyPipeline(t, "negative").deterministicPass).toBe(false);
	});

	it("negative: abstained → abstained-correctly (pass)", () => {
		const t = buildTrace(
			obs({ markerEmitted: false, responseText: "많이 힘들겠다. 곁에 있을게." }),
			probe,
			contains,
		);
		expect(classifyPipeline(t, "negative").bucket).toBe("abstained-correctly");
		expect(classifyPipeline(t, "negative").deterministicPass).toBe(true);
	});
});
