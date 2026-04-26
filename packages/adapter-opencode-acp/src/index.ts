/**
 * @nextain/agent-adapter-opencode-acp — Phase 2 Day 1
 *
 * opencode ACP (Agent Client Protocol v1) SubAgentAdapter.
 * Spawns `opencode acp` server, communicates via JSON-RPC over stdio.
 *
 * Decisions: D18 (Hybrid wrapper) + D24 (supervisor) + D39 (pause unsupported)
 * Spec: docs/adapter-contract.md §3 + r4-phase-2-spec.md
 *
 * P0-2 (Reference): redact mandatory wrapper at events() emit boundary.
 * P0-3 (Reference): TaskSpec.env에 NAIA_SESSION_ID/NAIA_WORKDIR/NAIA_TIER inject.
 * P0-4 (Architect): ApprovalBroker DI via SpawnContext.
 * P0-5 (Paranoid): stdout EOF / acp process kill → 500ms graceful shutdown (C12).
 */

export { AcpClient } from "./acp-client.js";
export type {
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpHandler,
} from "./acp-client.js";
export { OpencodeAcpAdapter } from "./opencode-acp-adapter.js";
export type { OpencodeAcpAdapterOptions } from "./opencode-acp-adapter.js";
