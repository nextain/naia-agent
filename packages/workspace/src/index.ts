/**
 * @nextain/agent-workspace — Phase 1 Day 3
 *
 * ChokidarWatcher + GitDiff implementations of WorkspaceWatcher.
 * Decisions: D19 (workspace 가시성) + D20 (workspace_change chunk).
 *
 * Spec: docs/adapter-contract.md §6
 */

export { ChokidarWatcher } from "./chokidar-watcher.js";
export type { ChokidarWatcherOptions } from "./chokidar-watcher.js";
export { gitDiff, gitDiffStats } from "./git-diff.js";
