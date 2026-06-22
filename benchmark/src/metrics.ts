/**
 * 5-axis metric collectors — deterministic, pure, orchestration-independent.
 *
 * Each function takes either raw observations or per-probe judgements and
 * returns a single scalar in [0, 1] (higher = better) for accuracy/recall/drift,
 * or absolute milliseconds for latency.
 *
 * Design notes:
 * - task-accuracy / fact-recall are pure aggregations over already-collected
 *   per-probe judgements (the judge call itself lives elsewhere = later stage).
 * - latency uses p50/p99 (not mean) — bursty reactive compaction is the
 *   precise failure mode we want to surface.
 * - drift is asymmetric: 1.0 = identical to no-compact baseline, < 1.0 measures
 *   divergence via token-overlap Jaccard.
 *
 * Ported faithfully from the pre-rewrite monorepo
 * (`packages/benchmarks/src/metrics.ts`). No console / process I/O — these are
 * pure functions that RETURN their results (repo rule F-LOG-3).
 */

import type { FixtureProbe } from "./fixture.js";

export interface ProbeJudgement {
	readonly probe: FixtureProbe;
	readonly response: string;
	/** true = probe satisfied; for fact-recall this is keyword-match OR judge agreement. */
	readonly pass: boolean;
	/** Optional LLM-judge agreement count (out of N judges) when ensemble was used. */
	readonly judgeAgreement?: number;
}

export interface LatencySample {
	readonly turnIdx: number;
	readonly latencyMs: number;
	/** True if this turn included a compaction call. */
	readonly compaction: boolean;
}

/**
 * Per-probe pass rate. Accepts ANY probe type but in practice the runner
 * separates fact-recall / task-accuracy / drift into three distinct calls.
 */
export function taskAccuracy(judgements: readonly ProbeJudgement[]): number {
	if (judgements.length === 0) return 0;
	const pass = judgements.filter((j) => j.pass).length;
	return pass / judgements.length;
}

/**
 * Fact-recall is a pass/fail per probe — same shape as taskAccuracy but
 * filtered to `type === "fact-recall"`. Keyword match runs in the runner
 * before we get here; this just aggregates.
 */
export function factRecall(judgements: readonly ProbeJudgement[]): number {
	const filtered = judgements.filter((j) => j.probe.type === "fact-recall");
	return taskAccuracy(filtered);
}

/**
 * Compute p50/p99 from latency samples. Sort then index — N≤1000 fine for
 * benchmark scale; if we ever push past 10k samples, switch to t-digest.
 */
export function latencyPercentiles(samples: readonly LatencySample[]): {
	p50: number;
	p99: number;
	compactionAvg: number;
} {
	if (samples.length === 0) return { p50: 0, p99: 0, compactionAvg: 0 };
	const sorted = [...samples].map((s) => s.latencyMs).sort((a, b) => a - b);
	const p50Idx = Math.floor(sorted.length * 0.5);
	const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
	const compactionSamples = samples.filter((s) => s.compaction);
	const compactionAvg =
		compactionSamples.length === 0
			? 0
			: compactionSamples.reduce((acc, s) => acc + s.latencyMs, 0) / compactionSamples.length;
	return {
		p50: sorted[p50Idx] ?? 0,
		p99: sorted[p99Idx] ?? 0,
		compactionAvg,
	};
}

/**
 * Drift between two responses. Token-overlap Jaccard as a cheap, deterministic
 * proxy for semantic divergence (1.0 = identical, lower = more divergent).
 */
export function driftScore(compactResponse: string, baselineResponse: string): number {
	if (compactResponse === baselineResponse) return 1.0;
	const tokens = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s]/gu, " ")
				.split(/\s+/)
				.filter((t) => t.length > 0),
		);
	const a = tokens(compactResponse);
	const b = tokens(baselineResponse);
	if (a.size === 0 && b.size === 0) return 1.0;
	const intersection = [...a].filter((t) => b.has(t)).length;
	const union = a.size + b.size - intersection;
	return union === 0 ? 1.0 : intersection / union;
}
