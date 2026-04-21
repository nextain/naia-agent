/**
 * MCPClient — thin wrapper around `@modelcontextprotocol/sdk` that lets a
 * naia-agent host bridge external MCP servers as a ToolExecutor.
 *
 * SDK is a **peerDependency** of @nextain/agent-runtime — hosts bring
 * their own version. This file imports the SDK types through `import type`
 * so the package builds without the SDK installed; runtime code lazily
 * requires the SDK only when `connect()` is called.
 *
 * Scope (Phase 2 X4 start):
 *   - Spawn/connect one MCP server via stdio transport
 *   - Discover its tools (tools/list)
 *   - Dispatch a single tool call
 *   - Aggregate multiple MCPClient instances into a ToolExecutor
 *
 * Deferred:
 *   - Resources/prompts (MCP capabilities beyond tools)
 *   - Reconnection, server-sent notifications
 *   - Stream-based HTTP transport
 */

import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
  TierLevel,
} from "@nextain/agent-types";

/** Configuration for connecting to a single MCP server via stdio. */
export interface MCPServerConfig {
  /** Human-readable server id. Also used as the tool-name prefix to avoid
   *  collisions when multiple MCP servers expose the same tool name. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Default tier for every tool exposed by this server. Host can override
   *  per-tool via `tierOverrides`. */
  defaultTier?: TierLevel;
  tierOverrides?: Record<string, TierLevel>;
}

/**
 * A single MCP server connection. Wraps the SDK's `Client` +
 * `StdioClientTransport`. Use `MCPToolExecutor` below to aggregate
 * multiple servers behind one `ToolExecutor`.
 */
export class MCPClient {
  readonly config: MCPServerConfig;
  #client: unknown | null = null;
  #connected = false;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;

    // Lazy SDK import so runtime package builds without SDK installed.
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]);

    const client = new Client(
      { name: "naia-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) },
    });
    await client.connect(transport);
    this.#client = client;
    this.#connected = true;
  }

  async listTools(): Promise<ToolDefinitionWithTier[]> {
    if (!this.#connected || !this.#client) {
      throw new Error(`MCPClient[${this.config.name}] not connected`);
    }
    const client = this.#client as {
      listTools: (cursor?: { cursor?: string }) => Promise<{
        tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[];
        nextCursor?: string;
      }>;
    };
    const defaultTier: TierLevel = this.config.defaultTier ?? "T1";
    const overrides = this.config.tierOverrides ?? {};
    const prefix = this.config.name;
    const out: ToolDefinitionWithTier[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        const def: ToolDefinitionWithTier = {
          // Namespace tool names so multiple servers can coexist.
          name: `${prefix}:${t.name}`,
          inputSchema: t.inputSchema,
          tier: overrides[t.name] ?? defaultTier,
        };
        if (t.description !== undefined) def.description = t.description;
        out.push(def);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(
    unqualifiedName: string,
    input: unknown,
  ): Promise<ToolExecutionResult> {
    if (!this.#connected || !this.#client) {
      throw new Error(`MCPClient[${this.config.name}] not connected`);
    }
    const client = this.#client as {
      callTool: (req: { name: string; arguments: unknown }) => Promise<{
        content?: { type: string; text?: string; [k: string]: unknown }[];
        isError?: boolean;
      }>;
    };
    const result = await client.callTool({ name: unqualifiedName, arguments: input });
    // Flatten MCP's content array into a single string, preserving isError.
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
    const out: ToolExecutionResult = {
      content: text,
    };
    if (result.isError === true) out.isError = true;
    return out;
  }

  async close(): Promise<void> {
    if (!this.#connected || !this.#client) return;
    const client = this.#client as { close: () => Promise<void> };
    try {
      await client.close();
    } catch {
      // swallow — disconnected/already-closed
    }
    this.#connected = false;
    this.#client = null;
  }

  get connected(): boolean {
    return this.#connected;
  }
}

/**
 * Aggregates multiple `MCPClient` instances behind the `ToolExecutor`
 * contract. The agent's HostContext.tools can be this executor when the
 * host wants MCP-discovered tools available to the LLM.
 *
 * Namespacing: tool name is `{serverName}:{toolName}`. Agent's
 * `invocation.name` must match that format for `execute()` to route.
 */
export class MCPToolExecutor implements ToolExecutor {
  readonly #servers: MCPClient[];

  constructor(servers: MCPClient[]) {
    this.#servers = servers;
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.#servers.map((s) => s.connect()));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.#servers.map((s) => s.close()));
  }

  async list(): Promise<ToolDefinitionWithTier[]> {
    const lists = await Promise.all(
      this.#servers.filter((s) => s.connected).map((s) => s.listTools()),
    );
    return lists.flat();
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const colon = invocation.name.indexOf(":");
    if (colon < 0) {
      return {
        content: `MCPToolExecutor: tool name "${invocation.name}" is not namespaced (expected "server:tool")`,
        isError: true,
      };
    }
    const serverName = invocation.name.slice(0, colon);
    const toolName = invocation.name.slice(colon + 1);
    const server = this.#servers.find((s) => s.config.name === serverName);
    if (!server) {
      return {
        content: `MCPToolExecutor: no server named "${serverName}"`,
        isError: true,
      };
    }
    try {
      return await server.callTool(toolName, invocation.input);
    } catch (err) {
      return {
        content: `MCPToolExecutor: ${serverName}:${toolName} threw — ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
