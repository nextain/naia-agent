/**
 * @nextain/agent-benchmarks — Slice 3-XR-Compact P1 skeleton.
 *
 * Public exports. Internal helpers (validation, math) are deliberately
 * exported so the test suite can exercise them without diving into module
 * internals.
 */

export type {
	Fixture,
	FixtureProbe,
	FixtureResult,
	FixtureRole,
	FixtureTurn,
	StrategyId,
} from "./fixture.js";
export { validateFixture } from "./fixture.js";

export type { ProbeJudgement, LatencySample } from "./metrics.js";
export { taskAccuracy, factRecall, latencyPercentiles, driftScore } from "./metrics.js";

export type { ReportInput } from "./report.js";
export { renderReport } from "./report.js";

export { loadFixtures, runFixturePlaceholder, main as runCli } from "./runner.js";

// Human-like memory experience bench (2026-07-04) — deterministic core.
// The live runner lives in examples/humanlike-memory-bench.ts (opt-in Gemini).
export type {
	HumanlikeScenario,
	HumanlikeSession,
	HumanlikeProbe,
	ProbeFamily,
	ProbePolarity,
	PipelineTrace,
	PipelineOutcome,
	PipelineBucket,
} from "./humanlike/types.js";
export { classifyPipeline, summarize } from "./humanlike/pipeline.js";
export { buildTrace, isDegenerateResponse } from "./humanlike/observe.js";
export type { ProbeObservation, Contains } from "./humanlike/observe.js";
export {
	HUMANLIKE_SCENARIOS,
	PREF_VEGETARIAN,
	EMO_DOG_LOSS,
	EMO_MARATHON,
	PREF_COFFEE,
} from "./humanlike/scenarios.js";
export {
	buildSocialQualityPrompt,
	parseSocialQualityReply,
	median,
	medianAxes,
	aggregateSocialQuality,
	judgeSocialQuality,
	defaultSocialQualityJudges,
	SOCIAL_QUALITY_PASS_THRESHOLD,
} from "./humanlike/judge.js";
export type {
	SocialQualityAxes,
	SocialQualityVerdict,
	SocialQualityAggregate,
	SocialQualityInput,
	ScoredJudge,
	ScoredJudgeResult,
} from "./humanlike/judge.js";
export { claudeJudge } from "./judges/cli-judge.js";
export {
	HUMANLIKE_FIXTURE_VERSION,
	replayProbe,
	replayFixture,
	renderHumanlikeReport,
} from "./humanlike/fixture.js";
export type {
	HumanlikeFixture,
	RecordedProbe,
	RecordedTrace,
	ReplayResult,
	ReportRow,
} from "./humanlike/fixture.js";
