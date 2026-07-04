/**
 * Deterministic 5-bucket pipeline classifier for the human-like memory bench.
 *
 * Pure module — no model, no I/O. Given a PipelineTrace (produced by the live
 * runner) and the probe's polarity, classify the outcome so a failure
 * attributes cleanly to the agent-loop, the memory layer, or response style.
 *
 * Flagship cross-review (Claude + GPT-5.5) key rule: "recall missed" is NOT a
 * memory failure unless the agent actually queried. No recall marker →
 * agent-loop recall-DECISION failure. And negative/control probes invert the
 * target: the good outcome is the agent NOT forcing the memory in.
 */
import type { PipelineTrace, PipelineOutcome, ProbePolarity } from "./types.js";

export function classifyPipeline(
	trace: PipelineTrace,
	polarity: ProbePolarity,
): PipelineOutcome {
	const base = { probeId: trace.probeId };

	if (polarity === "negative") {
		// Control: recall would be socially inappropriate. The human-like
		// behavior is to NOT surface it. Using the target — or worse, a
		// forbidden memory — is the failure ("creepy database").
		if (trace.forbiddenSurfaced || trace.targetUsed) {
			return { ...base, bucket: "forced-inappropriate", deterministicPass: false, failureLayer: "agent-integration" };
		}
		return { ...base, bucket: "abstained-correctly", deterministicPass: true, failureLayer: null };
	}

	// Positive probe: recall SHOULD surface, appropriately.
	if (!trace.recallAttempted) {
		// The agent never sought memory — an agent-loop decision failure, NOT
		// a memory-retrieval failure.
		return { ...base, bucket: "no-recall-attempt", deterministicPass: false, failureLayer: "agent-decision" };
	}
	if (!trace.targetRetrieved) {
		// Queried, but the store did not return an acceptable memory.
		return { ...base, bucket: "retrieval-miss", deterministicPass: false, failureLayer: "memory-retrieval" };
	}
	if (!trace.targetUsed) {
		// Retrieved into context but the response ignored it.
		return { ...base, bucket: "not-used", deterministicPass: false, failureLayer: "agent-integration" };
	}
	// Target used — but was it appropriate/natural/faithful? The judge layer
	// (flagship ensemble, social-quality only) decides. If a forbidden memory
	// was ALSO surfaced, it's already a determinable failure.
	if (trace.forbiddenSurfaced) {
		return { ...base, bucket: "forced-inappropriate", deterministicPass: false, failureLayer: "agent-integration" };
	}
	return { ...base, bucket: "used-needs-judge", deterministicPass: null, failureLayer: null };
}

/** Aggregate deterministic layer-attribution counts over many outcomes. */
export function summarize(outcomes: readonly PipelineOutcome[]): {
	total: number;
	needsJudge: number;
	deterministicPass: number;
	deterministicFail: number;
	byBucket: Record<string, number>;
	byFailureLayer: Record<string, number>;
} {
	const byBucket: Record<string, number> = {};
	const byFailureLayer: Record<string, number> = {};
	let needsJudge = 0;
	let pass = 0;
	let fail = 0;
	for (const o of outcomes) {
		byBucket[o.bucket] = (byBucket[o.bucket] ?? 0) + 1;
		if (o.deterministicPass === null) needsJudge++;
		else if (o.deterministicPass) pass++;
		else fail++;
		if (o.failureLayer) byFailureLayer[o.failureLayer] = (byFailureLayer[o.failureLayer] ?? 0) + 1;
	}
	return { total: outcomes.length, needsJudge, deterministicPass: pass, deterministicFail: fail, byBucket, byFailureLayer };
}
