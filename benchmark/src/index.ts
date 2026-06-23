/**
 * @nextain naia-agent benchmark — Stage 1b barrel.
 *
 * Public surface a host assembles a bench run from: the GENERIC runner (drives
 * a fixture through an injected SystemUnderTest, scores deterministically with
 * the Stage-1a metrics/judges) + the pure markdown report + a thin recall SUT
 * adapter, re-exporting the Stage-1a scoring core so a caller imports from one
 * place. Kept minimal (Karpathy: no speculative surface).
 */

// ── Fixture schema + validator (Stage 1a) ──────────────────────────────────
export type {
	Fixture,
	FixtureProbe,
	FixtureRole,
	FixtureTurn,
	StrategyId,
} from "./fixture.js";
export { validateFixture } from "./fixture.js";

// ── Deterministic metrics (Stage 1a) ────────────────────────────────────────
export type { ProbeJudgement, LatencySample } from "./metrics.js";
export { taskAccuracy, factRecall, latencyPercentiles, driftScore } from "./metrics.js";

// ── Korean recall judge + tier gate (Stage 1a) ──────────────────────────────
export type { TrialResult, TierGate, TierVerdict } from "./recall-judge.js";
export {
	koIncludes,
	koNormalizeForJudge,
	KO_SYNONYM_MAP,
	WELL_FORMED_MARKER,
	LOOSE_MARKER_LEAK,
	TIER_GATES,
	tierForModel,
	evaluateTier,
} from "./recall-judge.js";

// ── Ensemble judge aggregation (Stage 1a) ───────────────────────────────────
export type { JudgeResult, JudgeVerdict, EnsembleVerdict, Judge, JudgeInput } from "./judges/types.js";
export { isInfraError } from "./judges/types.js";
export type { JudgeResults } from "./judges/ensemble.js";
export { aggregateEnsemble } from "./judges/ensemble.js";

// ── Runner (Stage 1b) ───────────────────────────────────────────────────────
export type {
	FixtureInput,
	ProbeResponse,
	SystemUnderTest,
	FixtureScores,
	ProbeDetail,
	FixtureResult,
	PassThresholds,
} from "./runner.js";
export { runFixture, runFixtures, DEFAULT_THRESHOLDS } from "./runner.js";

// ── Report (Stage 1b) ───────────────────────────────────────────────────────
export { formatReport } from "./report.js";

// ── Recall SUT adapter (Stage 1b, thin) ─────────────────────────────────────
export type { RecallTurn, SaveFn, RecallFn, RecallSutDeps } from "./sut-recall.js";
export { createRecallSut } from "./sut-recall.js";
