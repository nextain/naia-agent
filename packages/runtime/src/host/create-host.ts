// Host factory — assembles HostContext for bin/naia-agent and embedded uses.
//
// Slice 1a (R3): mock LLM only.
// Slice 1b (R3): real LLM injection via opts.llm. The host (bin/naia-agent
// or embedder) constructs the LLMClient (Slice 5.x.4: VercelClient wrapping
// any Vercel AI SDK LanguageModelV2, or LabProxyClient for naia gateway)
// and passes it in. We keep concrete client construction OUT of this file
// to preserve runtime's zero-runtime-dep posture relative to providers
// (matrix A.3).
//
// DI policy: simple object injection (matrix C22). No container framework.

import type { HostContext, LLMClient, MemoryProvider, ToolExecutor } from "@nextain/agent-types";
import {
  ConsoleLogger,
  InMemoryMeter,
  NoopTracer,
} from "@nextain/agent-observability";
import { InMemoryMemory } from "../mocks/in-memory-memory.js";
import { InMemoryToolExecutor, type InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";
import { MockLLMClient, type MockScript } from "../mocks/mock-llm-client.js";
import { createBashSkill } from "../skills/bash.js";
import { createFileOpsSkills, type FileOpsOptions } from "../skills/file-ops.js";
import type { Logger } from "@nextain/agent-types";

export interface CreateHostOptions {
  llm?: LLMClient;
  memory?: MemoryProvider;
  tools?: ToolExecutor;
  /** Pre-constructed Logger. If omitted, a ConsoleLogger is created with `logLevel`. */
  logger?: Logger;
  logLevel?: "debug" | "info" | "warn" | "error";
  // Mock LLM script (used only when llm not provided).
  mockScript?: MockScript;
  /** Slice 2 — register the built-in `bash` skill (T1, DANGEROUS_COMMANDS-filtered). */
  enableBash?: boolean;
  /** Slice 2.6 — register read_file/write_file/edit_file/list_files skills (T0/T1, D09 sentinel). */
  enableFiles?: boolean;
  /** Slice 2.6 — file-ops options (workspaceRoot, maxBytes). */
  fileOpsOptions?: FileOpsOptions;
  /** Slice 2 — register additional InMemoryToolDef[] (advanced). */
  extraTools?: InMemoryToolDef[];
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
  const logger = opts.logger ?? new ConsoleLogger({ level: opts.logLevel ?? "warn" });
  const fn = logger.fn?.("createHost", {
    enableBash: !!opts.enableBash,
    enableFiles: !!opts.enableFiles,
    hasLLM: !!opts.llm,
    hasMemory: !!opts.memory,
  });

  const llm = opts.llm ?? new MockLLMClient(opts.mockScript ?? defaultMockScript());
  const memory = opts.memory ?? new InMemoryMemory();

  let tools: ToolExecutor;
  if (opts.tools) {
    fn?.branch("tools-injected");
    tools = opts.tools;
  } else {
    const builtins: InMemoryToolDef[] = [];
    if (opts.enableBash) builtins.push(createBashSkill({ logger }));
    if (opts.enableFiles) builtins.push(...createFileOpsSkills({ ...opts.fileOpsOptions, logger }));
    if (opts.extraTools) builtins.push(...opts.extraTools);
    fn?.branch("tools-built", { count: builtins.length });
    tools = new InMemoryToolExecutor(builtins);
  }

  fn?.exit({ toolCount: "set" });
  return {
    llm,
    memory,
    tools,
    logger,
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
