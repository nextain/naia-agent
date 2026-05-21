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
export { validateFixture, classifyProbeStress } from "./fixture.js";

// R7 Phase A.2: shared visible-context builder (single source of truth
// for both runner.ts:evaluateProbe and mini-bench-judge.ts).
export type { VisibleContextInput, VisibleContextOutput } from "./visible-context.js";
export { buildVisibleContext } from "./visible-context.js";

export type { ProbeJudgement, LatencySample } from "./metrics.js";
export { taskAccuracy, factRecall, latencyPercentiles, driftScore } from "./metrics.js";

export type { ReportInput } from "./report.js";
export { renderReport } from "./report.js";

export { loadFixtures, runFixturePlaceholder, main as runCli } from "./runner.js";
