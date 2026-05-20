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
