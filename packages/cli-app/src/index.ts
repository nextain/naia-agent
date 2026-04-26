/**
 * @nextain/agent-cli-app — Phase 1 Day 5
 *
 * Supervisor + StreamMerger + CLI renderer wiring used by bin/naia-agent.
 * Phase 1 scope: 1 sub-agent (opencode-cli or shell) + workspace watcher +
 * post-task verification + numeric report. No LLM call (supervisor passes
 * prompt directly to sub-agent). No multi-session, no voice, no alpha-memory.
 *
 * Decisions: D18/D19/D20/D21/D24
 * Spec: r4-phase-1-spec.md Day 5
 */

export { mergeStreams } from "./stream-merger.js";
export { Phase1Supervisor } from "./supervisor.js";
export type { Phase1SupervisorOptions } from "./supervisor.js";
export { renderChunk, runCli } from "./cli-renderer.js";
export type { CliOptions } from "./cli-renderer.js";
export {
  CliApprovalBroker,
  AutoDenyApprovalBroker,
  AutoApproveApprovalBroker,
} from "./approval-broker.js";
export type { CliApprovalBrokerOptions } from "./approval-broker.js";
export { InterruptManager } from "./interrupt-manager.js";
export type { InterruptManagerOptions } from "./interrupt-manager.js";
