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

export { SkillToolExecutor } from "./skill-tool-bridge.js";
export type { SkillToolExecutorOptions } from "./skill-tool-bridge.js";

export { CompositeToolExecutor } from "./composite-tool-executor.js";
export type {
  CompositeSub,
  CompositeToolExecutorOptions,
} from "./composite-tool-executor.js";

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

// Host factory — Slice 1a R3. Assembles HostContext for bin and embedded uses.
export { createHost } from "./host/index.js";
export type { CreateHostOptions } from "./host/index.js";

// Testing — Slice 1b R3. StreamPlayer for fixture-replay (minimal pin;
// formalized as @nextain/agent-testing in Slice 5).
export { StreamPlayer } from "./testing/index.js";
export type { StreamPlayerFixture } from "./testing/index.js";

// Workspace sentinel — D09 (Slice 1b). OWASP A01 Path Traversal guard.
export {
  normalizeWorkspacePath,
  WorkspaceEscapeError,
} from "./utils/path-normalize.js";

// Env + JSON config auto-loader — Slice 1c. Native .env parser + flatten JSON.
export { loadEnvAndConfig, parseEnv, flattenConfig } from "./utils/env-loader.js";
export type { EnvLoadOptions, EnvLoadReport } from "./utils/env-loader.js";
