/**
 * LLM-judge types — shared verdict shapes for the ensemble aggregation.
 *
 * Objective measurement of compaction / handoff quality requires a panel of
 * independent judges. Each judge returns the same shape so the aggregation can
 * majority-vote without per-judge branching.
 *
 * Ported faithfully from the pre-rewrite monorepo
 * (`packages/benchmarks/src/judges/types.ts`). Stage 1a keeps only the pure
 * verdict/result types + the `isInfraError` discriminator + the ensemble result
 * shape. The concrete judge transports (CLI/HTTP) are deferred — `Judge` /
 * `JudgeInput` are retained as the contract a future adapter implements, but no
 * judge is invoked from this module.
 */

export interface JudgeVerdict {
	/** Did the response satisfy the criterion? */
	readonly pass: boolean;
	/** Free-text reason — surfaced in reports for the failure cases. */
	readonly reason: string;
	/** Latency for this judge call in milliseconds. */
	readonly latencyMs: number;
	/** Approximate tokens consumed (for cost tracking). */
	readonly approxTokens?: number;
}

export interface JudgeInfraError {
	/** Identifies that the judge could not run (CLI missing, key missing,
	 *  network down, etc.). Excluded from majority vote. */
	readonly infraError: string;
	readonly latencyMs: number;
}

export type JudgeResult = JudgeVerdict | JudgeInfraError;

export function isInfraError(r: JudgeResult): r is JudgeInfraError {
	return "infraError" in r;
}

export interface JudgeInput {
	/** What was asked of the assistant — the user's probe. */
	readonly question: string;
	/** The assistant's actual response we're judging. */
	readonly response: string;
	/** What "pass" means for this probe (free-form description). */
	readonly criterion: string;
	/** Optional context — fixture id, probe id, anything useful for the
	 *  judge's reasoning. NOT sent verbatim if it would leak fixture state. */
	readonly meta?: Record<string, string>;
	/** Per-call timeout cap in milliseconds (default 30s). */
	readonly timeoutMs?: number;
}

/** Judge function signature — every concrete judge (later stage) implements this. */
export type Judge = (input: JudgeInput) => Promise<JudgeResult>;

/** Ensemble result — majority of valid (non-infra-error) verdicts. */
export interface EnsembleVerdict {
	readonly pass: boolean;
	readonly reason: string;
	readonly perJudge: Readonly<Record<string, JudgeResult>>;
	/** Out of `Object.keys(perJudge).length`, how many returned a real verdict. */
	readonly validCount: number;
	readonly infraErrorCount: number;
	/** validCount === 0 → ensemble verdict is unreliable; caller should flag. */
	readonly unreliable: boolean;
}
