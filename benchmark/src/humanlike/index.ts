// UC-HLMEM barrel — human-like memory measurement (memory-as-user-model).
// Contract: docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md
export type {
  SeedTurn, HumanlikeUser, HumanlikeOption, HumanlikeFamily, HumanlikeScenario,
  MemoryCondition, HumanlikeTrace, HumanlikeOutcome, HumanlikeResult,
} from "./types.js";
export { parsePrediction, isDegenerateResponse, assignOptions, type AssignedOptions } from "./parse.js";
export { classifyHumanlikeTrace, buildResult } from "./pipeline.js";
export {
  predictionAccuracy, summarize, type ConditionStat, type HumanlikeSummary,
} from "./metrics.js";
export { PREFERENCE_SCENARIOS, SELF_SPEC_SCENARIOS, HUMANLIKE_SCENARIOS } from "./scenarios.js";
export {
  HUMANLIKE_FIXTURE_VERSION, replayFixture, validateFixture,
  type RecordedProbe, type HumanlikeFixture,
} from "./fixture.js";
