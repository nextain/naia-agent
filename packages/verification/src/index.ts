/**
 * @nextain/agent-verification — Phase 1 Day 4
 *
 * Verifier orchestrator + runners (test/typecheck/lint/build) for honest
 * post-task reports. Decisions: D19 (정직 보고) + D27 (3중 방어).
 *
 * Spec: docs/adapter-contract.md §5
 */

export { TestVerifier } from "./runners/test.js";
export { TypeCheckVerifier } from "./runners/typecheck.js";
export { LintVerifier } from "./runners/lint.js";
export { BuildVerifier } from "./runners/build.js";
export { VerificationOrchestrator } from "./orchestrator.js";
export type { OrchestratorOptions } from "./orchestrator.js";
export { formatReport, reportStatsFromInput } from "./reporter.js";
export type { FormatReportInput } from "./reporter.js";
export { runShellVerifier } from "./runners/shell.js";
