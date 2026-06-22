/**
 * Ensemble aggregation — majority of valid (non-infra-error) judges.
 *
 * Infra errors (CLI missing, key missing, timeout, parse fail) are EXCLUDED
 * from the vote — they're surfaced separately via `infraErrorCount`. When
 * `validCount === 0` (every judge hit an infra error) the ensemble verdict is
 * marked `unreliable=true` and `pass=false` (inconclusive).
 *
 * Ported from the pre-rewrite monorepo (`packages/benchmarks/src/judges/
 * ensemble.ts`). Stage 1a deliberately keeps ONLY the pure aggregation:
 *
 *   OLD `runEnsemble(spec, input)` both (a) invoked each judge over a transport
 *   (Promise.all over `spec.judges[name](input)`) AND (b) aggregated the
 *   results. Invoking judges is process/HTTP transport = a later stage. So the
 *   aggregation is refactored into a PURE function (`aggregateEnsemble`) that
 *   takes the ALREADY-COLLECTED per-judge results and returns the consensus.
 *   A future adapter collects the results (CLI/GLM judges) and feeds them here.
 *
 * The vote/exclusion/unreliable arithmetic is preserved EXACTLY (same input →
 * same output). No console / process I/O (repo rule F-LOG-3).
 */

import type { EnsembleVerdict, JudgeResult } from "./types.js";
import { isInfraError } from "./types.js";

/**
 * Already-collected per-judge results, keyed by judge name. This is what an
 * orchestrator (later stage) produces after invoking each judge; the
 * aggregation below is pure over it.
 */
export type JudgeResults = Readonly<Record<string, JudgeResult>>;

/**
 * Pure majority-vote aggregation with infra-error exclusion.
 *
 * - Infra errors are excluded from the pass/fail tally (counted separately).
 * - `majority = pass > fail` (strict — a tie is NOT a majority).
 * - `validCount === 0` (all judges infra-errored) → `unreliable=true`,
 *   `pass=false`, and a descriptive `reason`.
 *
 * Iteration order follows `Object.keys(results)` (insertion order for string
 * keys), so the `reason` string and `perJudge` map are deterministic for a
 * given input.
 */
export function aggregateEnsemble(results: JudgeResults): EnsembleVerdict {
	const perJudge: Record<string, JudgeResult> = {};
	let pass = 0;
	let fail = 0;
	let infra = 0;
	const reasons: string[] = [];
	for (const name of Object.keys(results)) {
		const r = results[name]!;
		perJudge[name] = r;
		if (isInfraError(r)) {
			infra++;
		} else {
			if (r.pass) pass++;
			else fail++;
			reasons.push(`${name}: ${r.pass ? "PASS" : "FAIL"} ${r.reason}`);
		}
	}
	const validCount = pass + fail;
	const unreliable = validCount === 0;
	const majority = pass > fail;

	return {
		pass: !unreliable && majority,
		reason:
			reasons.length > 0
				? reasons.join(" | ")
				: `unreliable: all ${infra} judges hit infra errors`,
		perJudge,
		validCount,
		infraErrorCount: infra,
		unreliable,
	};
}
