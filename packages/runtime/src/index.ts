// @nextain/agent-runtime — runtime helpers for contract impls.
// Phase 2 X2 scaffold. More helpers to follow (MCP bridge).

export { GatedToolExecutor } from "./tool-executor.js";
export type { GatedToolExecutorOptions } from "./tool-executor.js";

export { FileSkillLoader } from "./skill-loader.js";
export type {
  FileSkillLoaderOptions,
  SkillLoader,
  SkillDescriptor,
  SkillInput,
  SkillOutput,
} from "./skill-loader.js";

// Mocks for tests, examples, and bootstrap hosts.
export {
  InMemoryMemory,
  CompactableMemory,
  MockLLMClient,
  InMemoryToolExecutor,
} from "./mocks/index.js";
export type {
  MockScript,
  MockTurn,
  InMemoryToolDef,
} from "./mocks/index.js";

// MCP bridge — Phase 2 X4. SDK (@modelcontextprotocol/sdk) is a peerDep.
export { MCPClient, MCPToolExecutor } from "./mcp/index.js";
export type { MCPServerConfig } from "./mcp/index.js";
