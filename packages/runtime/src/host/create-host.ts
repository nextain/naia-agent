// Host factory — assembles HostContext for bin/naia-agent and embedded uses.
//
// Slice 1a (R3): mock LLM only. Slice 1b adds real Anthropic / gateway
// (NAIA_GATEWAY_URL or ANTHROPIC_API_KEY env detection).
//
// DI policy: simple object injection (matrix C22). No container framework.

import type { HostContext, LLMClient, MemoryProvider, ToolExecutor } from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import { InMemoryMemory } from "../mocks/in-memory-memory.js";
import { InMemoryToolExecutor } from "../mocks/in-memory-tool-executor.js";
import { MockLLMClient, type MockScript } from "../mocks/mock-llm-client.js";

export interface CreateHostOptions {
  llm?: LLMClient;
  memory?: MemoryProvider;
  tools?: ToolExecutor;
  logLevel?: "debug" | "info" | "warn" | "error";
  // Mock LLM script (used only when llm not provided).
  mockScript?: MockScript;
}

/**
 * Creates a HostContext with sensible defaults.
 *
 * - llm: provided one, else MockLLMClient (Slice 1a path)
 * - memory: provided one, else InMemoryMemory
 * - tools: provided one, else empty InMemoryToolExecutor
 * - logger/tracer/meter: stdlib defaults
 * - approvals/identity: throwing shims (T0 only — caller must wire if T1+)
 */
export function createHost(opts: CreateHostOptions = {}): HostContext {
  const llm = opts.llm ?? new MockLLMClient(opts.mockScript ?? defaultMockScript());
  const memory = opts.memory ?? new InMemoryMemory();
  const tools = opts.tools ?? new InMemoryToolExecutor([]);

  return {
    llm,
    memory,
    tools,
    logger: new ConsoleLogger({ level: opts.logLevel ?? "warn" }),
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
    approvals: {
      async decide() {
        throw new Error("createHost: approvals not wired (T0 only — pass approvals to wire T1+)");
      },
    },
    identity: {
      deviceId: "naia-agent-cli",
      publicKeyEd25519: "dev-pubkey",
      async sign() {
        throw new Error("createHost: sign() not wired (provide identity to enable signing)");
      },
    },
  };
}

// Default mock script for Slice 1a smoke. One-turn echo of the input.
function defaultMockScript(): MockScript {
  return {
    turns: [
      {
        blocks: "Hello! I'm naia-agent in mock mode. Real LLM lands in Slice 1b.",
        stopReason: "end_turn",
      },
    ],
  };
}
