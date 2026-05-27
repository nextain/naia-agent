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

// Service manifest loader — R6/SB-1 (#32, matrix §D50). Pure parse/validate
// + memory-binding resolve. Schema SoT: naia-adk/docs/service-manifest-schema.md.
export {
  parseServiceManifest,
  resolveMemoryBinding,
  manifestBaseURLTrust,
  manifestInvalid,
  SUPPORTED_MANIFEST_MAJOR,
} from "./host/index.js";
export type {
  ServiceManifest,
  ManifestParseResult,
  AlphaMemoryFactory,
} from "./host/index.js";

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
export { loadEnvAndConfig, parseEnv, flattenConfig, readConfiguredAdkPath } from "./utils/env-loader.js";
export type { EnvLoadOptions, EnvLoadReport } from "./utils/env-loader.js";
// `naia-agent login` role-spec parser (pure; rejects raw secrets at write).
export { parseRoleSpec } from "./utils/login-spec.js";
export type { ParsedRole, ParseRoleResult } from "./utils/login-spec.js";
// `naia-agent --memory` pure decision logic (embed-URL norm + fallback gate).
export { normalizeEmbedBaseUrl, decideCliMemory } from "./utils/cli-memory.js";
export type { CliMemoryDecision } from "./utils/cli-memory.js";
// Cross-repo LLM config — naia-adk/naia-settings/llm.json reader.
export { loadNaiaSettingsLLM } from "./utils/naia-settings.js";
export type { NaiaSettingsOptions, NaiaSettingsReport } from "./utils/naia-settings.js";

// naia-gateway error classification + cold-start retry (Slice 5-RB1.a / 5-RB1.b).
export {
  classifyGatewayError,
  formatGatewayErrorMessage,
  coldStartDelayMs,
  coldStartTimeoutMessage,
  isEnglishLocale,
  COLD_START_MAX_ELAPSED_MS,
  COLD_START_BASE_DELAY_MS,
  COLD_START_MAX_DELAY_MS,
} from "./utils/gateway-errors.js";
export type {
  GatewayErrorClass,
  GatewayError,
} from "./utils/gateway-errors.js";

// naia-gateway fetch wrapper that wires error classification + retry into
// @ai-sdk/openai-compatible's `fetch` option (Slice 5-RB1.a / 5-RB1.b).
export { makeGatewayFetch } from "./utils/gateway-fetch.js";
export type { GatewayFetchDeps } from "./utils/gateway-fetch.js";

// naia-os instance_id resolver (Slice 5-RB1.d).
export { resolveInstanceId } from "./utils/instance-id.js";
export type { ResolveInstanceIdDeps, InstanceIdResolution } from "./utils/instance-id.js";

// naia-gateway heartbeat sender (Slice 5-RB1.c, safety-net layer [4]).
export {
  maybeStartHeartbeat,
  startHeartbeat,
} from "./utils/heartbeat.js";
export type {
  HeartbeatConfig,
  HeartbeatController,
  HeartbeatScheduler,
  HeartbeatHandle,
} from "./utils/heartbeat.js";
// OS-keychain secret store (device-key encrypted; no plaintext fallback).
export { getSecretStore, __setSecretStoreForTest, classifyProbe } from "./utils/secret-store.js";
export type { SecretStore } from "./utils/secret-store.js";

// Login subcommand pure helpers — Track B (G16). Side-effect-free, injectable for tests.
export { parseLoginArgs, checkDuplicateKeys, buildEnvAppend } from "./utils/login-ops.js";
export type { ProviderField } from "./utils/login-ops.js";
// Browser-based Naia login (localhost callback flow) — Slice 4-P2 (#59).
export { browserLogin, NAIA_WEB_BASE_URL } from "./utils/browser-auth.js";
export type { BrowserAuthResult } from "./utils/browser-auth.js";

// DANGEROUS_COMMANDS regex — D01 (Slice 2). OWASP A03 출처, F09 cleanroom 단독 의존 금지.
export {
  DANGEROUS_PATTERNS,
  checkDangerous,
  assertSafe,
  DangerousCommandError,
} from "./utils/dangerous-commands.js";
export type { DangerousMatch, DangerousCheckResult } from "./utils/dangerous-commands.js";

// Memory context fencing — G-NA-01 (ref-analysis-gap-plan-2026-05-12).
// Prevents <memory-context> blocks leaking into streaming UI. F09 OWASP A03/CWE-74.
export {
  sanitizeContext,
  StreamingContextScrubber,
  buildMemoryContextBlock,
} from "./memory-scrubber.js";

// Built-in skills — Slice 2 (Bash) + Slice 2.6 (file-ops).
export {
  createBashSkill,
  createCodingSkill,
  createReadFileSkill,
  createWriteFileSkill,
  createEditFileSkill,
  createListFilesSkill,
  createFileOpsSkills,
  createTimeSkill,
  createWeatherSkill,
  createMemoSkill,
  createSystemStatusSkill,
  createDiagnosticsSkill,
  createSessionsSkill,
  createConfigSkill,
} from "./skills/index.js";
export type { BashSkillOptions, BashInput, CodingSkillOptions, CodingInput, FileOpsOptions, TimeSkillOptions, WeatherSkillOptions, MemoSkillOptions, SystemStatusSkillOptions, DiagnosticsSkillOptions, SessionsSkillOptions, ConfigSkillOptions } from "./skills/index.js";

// Session + Config managers — Claude Code-level core infrastructure.
export { SessionManager } from "./session-manager.js";
export type { SessionRecord, SessionManagerOptions } from "./session-manager.js";
export { ConfigManager } from "./config-manager.js";
export type { AgentConfig, ConfigManagerOptions } from "./config-manager.js";
