/**
 * HostContext — the dependency-injection surface between host (shell/CLI/
 * server) and the naia-agent runtime.
 *
 * Hosts construct concrete implementations and pass them to the runtime at
 * startup. The runtime knows nothing about the host beyond these contracts.
 *
 * Plan A.5 mandates two scopes:
 *   HostContext.Core — minimal (llm + logger), for lightweight tests/agents
 *   HostContext      — full (all 8 fields), for production hosts
 */

import type { LLMClient } from "./llm.js";
import type { MemoryProvider } from "./memory.js";
import type { Logger, Tracer, Meter } from "./observability.js";
import type { ToolExecutor } from "./tool.js";
import type { ApprovalBroker } from "./approval.js";

export interface DeviceIdentity {
  deviceId: string;
  /** Base64 or hex-encoded public key. */
  publicKeyEd25519: string;
  /** Sign a payload with the device private key (held in host stronghold). */
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

/** Minimal HostContext — enough to run an LLM-only agent with logging. */
export interface HostContextCore {
  llm: LLMClient;
  logger: Logger;
}

/**
 * Full HostContext — all capabilities. Production hosts provide this.
 * Extends Core so a HostContext is assignable anywhere a Core is required.
 */
export interface HostContext extends HostContextCore {
  memory: MemoryProvider;
  tools: ToolExecutor;
  approvals: ApprovalBroker;
  identity: DeviceIdentity;
  tracer: Tracer;
  meter: Meter;
}
