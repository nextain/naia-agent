import { describe, expect, it } from "vitest";
import { classifyPipeline, summarize } from "../pipeline.js";
import type { PipelineTrace } from "../types.js";

const trace = (over: Partial<PipelineTrace>): PipelineTrace => ({
	probeId: "P",
	recallAttempted: false,
	targetRetrieved: false,
	targetUsed: false,
	...over,
});

describe("classifyPipeline — positive probes (recall SHOULD surface)", () => {
	it("no recall marker → agent-DECISION failure (not memory)", () => {
		const o = classifyPipeline(trace({ recallAttempted: false }), "positive");
		expect(o.bucket).toBe("no-recall-attempt");
		expect(o.deterministicPass).toBe(false);
		expect(o.failureLayer).toBe("agent-decision");
	});

	it("queried but target not returned → memory-retrieval failure", () => {
		const o = classifyPipeline(trace({ recallAttempted: true, targetRetrieved: false }), "positive");
		expect(o.bucket).toBe("retrieval-miss");
		expect(o.failureLayer).toBe("memory-retrieval");
	});

	it("retrieved but response ignored it → agent-integration failure", () => {
		const o = classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: false }), "positive");
		expect(o.bucket).toBe("not-used");
		expect(o.failureLayer).toBe("agent-integration");
	});

	it("target used cleanly → deferred to judge layer", () => {
		const o = classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: true }), "positive");
		expect(o.bucket).toBe("used-needs-judge");
		expect(o.deterministicPass).toBeNull();
		expect(o.failureLayer).toBeNull();
	});

	it("target used but a forbidden memory also surfaced → determinable failure", () => {
		const o = classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: true, forbiddenSurfaced: true }), "positive");
		expect(o.bucket).toBe("forced-inappropriate");
		expect(o.deterministicPass).toBe(false);
	});
});

describe("classifyPipeline — negative/control probes (recall would be INAPPROPRIATE)", () => {
	it("agent did not force the memory → abstained correctly (pass)", () => {
		const o = classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: false }), "negative");
		expect(o.bucket).toBe("abstained-correctly");
		expect(o.deterministicPass).toBe(true);
	});

	it("agent dragged the memory in → forced-inappropriate (fail = creepy DB)", () => {
		const o = classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: true }), "negative");
		expect(o.bucket).toBe("forced-inappropriate");
		expect(o.deterministicPass).toBe(false);
	});

	it("surfaced a forbidden memory → forced-inappropriate", () => {
		const o = classifyPipeline(trace({ targetUsed: false, forbiddenSurfaced: true }), "negative");
		expect(o.bucket).toBe("forced-inappropriate");
		expect(o.deterministicPass).toBe(false);
	});
});

describe("summarize", () => {
	it("aggregates buckets, judge-deferrals, and failure layers", () => {
		const outcomes = [
			classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: true }), "positive"), // needs-judge
			classifyPipeline(trace({ recallAttempted: false }), "positive"), // agent-decision fail
			classifyPipeline(trace({ recallAttempted: true, targetRetrieved: true, targetUsed: false }), "negative"), // abstained pass
		];
		const s = summarize(outcomes);
		expect(s.total).toBe(3);
		expect(s.needsJudge).toBe(1);
		expect(s.deterministicPass).toBe(1);
		expect(s.deterministicFail).toBe(1);
		expect(s.byFailureLayer["agent-decision"]).toBe(1);
	});
});
