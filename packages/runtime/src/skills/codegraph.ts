// Slice #68 — CodeGraph RAG skill.
//
// Spawns `codegraph serve --mcp --path <workdir>` as a subprocess and
// wraps its MCP tools behind the ToolExecutor contract. All codegraph
// tools are T0 (read-only, no side effects).
//
// Prerequisites for a non-null return:
//   1. `.codegraph/` index must exist in workdir  (`codegraph init -i`)
//   2. `codegraph` binary must be on PATH          (`npm i -g @colbymchenry/codegraph`)
//
// Both failures produce a null return — caller logs a warning and
// continues without code-intelligence tools (graceful degradation).

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { MCPClient, MCPToolExecutor } from "../mcp/index.js";

export interface CodeGraphOptions {
  /** Project directory whose `.codegraph/` index to serve. Default: process.cwd() */
  workdir?: string;
  /** Override the `codegraph` binary path. Default: "codegraph" (PATH lookup). */
  bin?: string;
}

/**
 * Creates a ToolExecutor backed by `codegraph serve --mcp`.
 *
 * Returns `null` when:
 *   - `.codegraph/` is absent in `workdir`   → not initialised, skip silently
 *   - `codegraph` binary fails to start      → not installed, skip silently
 *
 * The caller is responsible for closing the server when done:
 * ```ts
 * const cg = await createCodeGraphExecutor(opts);
 * if (cg) {
 *   // use cg as part of CompositeToolExecutor
 *   // on shutdown:
 *   await cg.closeAll();
 * }
 * ```
 */
export async function createCodeGraphExecutor(
  opts: CodeGraphOptions = {},
): Promise<MCPToolExecutor | null> {
  const workdir = resolve(opts.workdir ?? process.cwd());
  const bin = opts.bin ?? "codegraph";

  // Fast exit: no index means no tools.
  if (!existsSync(join(workdir, ".codegraph"))) {
    return null;
  }

  const client = new MCPClient({
    name: "codegraph",
    command: bin,
    args: ["serve", "--mcp", "--path", workdir],
    defaultTier: "T0",
  });

  try {
    await client.connect();
  } catch {
    // Binary missing or server startup failed — skip silently.
    return null;
  }

  return new MCPToolExecutor([client]);
}
