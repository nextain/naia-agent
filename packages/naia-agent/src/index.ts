/**
 * @nextain/naia-agent — Naia AI agent runtime aggregated package.
 *
 * Single entry point for the Naia agent ecosystem:
 *   - Agent runtime (core, types, protocol)
 *   - LLM providers (Vercel AI SDK, Lab proxy)
 *   - Runtime helpers (tool executor, skill loader)
 *   - Observability, workspace, verification
 *
 * Built-in skills available via "@nextain/naia-agent/skills".
 *
 * @example
 *   import { Agent } from "@nextain/naia-agent";
 *   import { BuiltinSkills } from "@nextain/naia-agent/skills";
 */

// Core runtime
export * from "@nextain/agent-core";

// Types (zero runtime dep — pure contracts)
export * from "@nextain/agent-types";

// Wire protocol
export * from "@nextain/agent-protocol";

// LLM providers
export * from "@nextain/agent-providers";

// Runtime helpers (tool executor, skill loader, etc.)
export * from "@nextain/agent-runtime";

// Observability
export * from "@nextain/agent-observability";

// Workspace
export * from "@nextain/agent-workspace";

// Verification
export * from "@nextain/agent-verification";

// Disambiguate: WorkspaceEscapeError exists in both agent-types and agent-runtime (path-normalize).
// Explicitly re-export the runtime version (path-traverse guard with relativePath/root context).
export { WorkspaceEscapeError } from "@nextain/agent-runtime";
