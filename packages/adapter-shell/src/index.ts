/**
 * @nextain/agent-adapter-shell — Shell SubAgentAdapter
 *
 * Phase 1 Day 1 — wraps an external CLI as child_process and emits
 * NaiaStreamChunk events. Used as fallback for opencode-cli and as
 * scaffolding for any tool that speaks plain stdio.
 *
 * Spec: docs/adapter-contract.md (R4 lock 2026-04-26)
 *
 * Decisions: D18 (Hybrid wrapper) + D24 (supervisor) + P0-6 (secret redact
 * mandatory) + P0-7 (interrupt 500ms hard kill, contract test C12).
 */

export { ShellAdapter } from "./shell-adapter.js";
export type { ShellAdapterOptions } from "./shell-adapter.js";
