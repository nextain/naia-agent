/**
 * CompositeToolExecutor — composes multiple ToolExecutors behind a single
 * ToolExecutor facade. The Agent's HostContext.tools can be this
 * composite when a host wants both skills (SkillToolExecutor) and MCP
 * servers (MCPToolExecutor) exposed to the LLM simultaneously.
 *
 * Routing rules:
 *   - `list()` aggregates definitions from every sub-executor, de-duplicates
 *     by tool name (first-registered wins), and remembers which sub owns
 *     each name.
 *   - `execute()` uses the ownership map built by the most recent `list()`
 *     to route. If the Agent invokes a tool that wasn't in the last
 *     `list()`, CompositeToolExecutor re-lists lazily.
 *
 * The Agent calls `list()` every tool-hop iteration (per careti pattern),
 * so the ownership map stays fresh. Costly rescans should be cached
 * inside each sub-executor (FileSkillLoader does this; MCPToolExecutor
 * already caches at the SDK level).
 */

import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "@nextain/agent-types";

export interface CompositeSub {
  /** Identifier for diagnostics. */
  id: string;
  executor: ToolExecutor;
}

export interface CompositeToolExecutorOptions {
  subs: CompositeSub[];
  /**
   * Warn sink for tool-name shadowing. Default: `console.warn`. Shadowing
   * happens when two subs expose the same tool name — first-registered
   * wins. **Sub order is a trust boundary**: if skills are listed before
   * MCP, an attacker controlling an MCP server cannot shadow a built-in
   * skill of the same name.
   */
  onWarn?: (message: string, context?: Record<string, unknown>) => void;
}

export class CompositeToolExecutor implements ToolExecutor {
  readonly #subs: CompositeSub[];
  readonly #onWarn: NonNullable<CompositeToolExecutorOptions["onWarn"]>;
  /** tool name → sub id, populated by list(). */
  #ownership = new Map<string, string>();
  #shadowed: ShadowRecord[] = [];
  #listed = false;

  constructor(options: CompositeToolExecutorOptions | CompositeSub[]) {
    const subs = Array.isArray(options) ? options : options.subs;
    if (subs.length === 0) throw new Error("CompositeToolExecutor: at least one sub-executor required");
    const seen = new Set<string>();
    for (const s of subs) {
      if (seen.has(s.id)) throw new Error(`CompositeToolExecutor: duplicate sub id "${s.id}"`);
      seen.add(s.id);
      if (!s.executor.list) {
        // A sub without list() can never be routed to — its execute() is
        // unreachable through the composite because ownership is built
        // from list() results. Surface at construction.
        (Array.isArray(options) || !options.onWarn ? console.warn : options.onWarn)(
          `[CompositeToolExecutor] sub "${s.id}" has no list() — its tools are unreachable via composite`,
        );
      }
    }
    this.#subs = subs;
    this.#onWarn =
      (Array.isArray(options) ? undefined : options.onWarn) ??
      ((msg, ctx) => {
        if (ctx) console.warn(`[CompositeToolExecutor] ${msg}`, ctx);
        else console.warn(`[CompositeToolExecutor] ${msg}`);
      });
  }

  async list(): Promise<ToolDefinitionWithTier[]> {
    const aggregated: ToolDefinitionWithTier[] = [];
    const nextOwnership = new Map<string, string>();
    const nextShadowed: ShadowRecord[] = [];
    for (const sub of this.#subs) {
      if (!sub.executor.list) continue;
      const defs = await sub.executor.list();
      for (const def of defs) {
        // First-registered wins. Record shadow for diagnostics.
        const winner = nextOwnership.get(def.name);
        if (winner) {
          nextShadowed.push({ name: def.name, winner, loser: sub.id });
          this.#onWarn(
            `tool "${def.name}" from sub "${sub.id}" shadowed by "${winner}"`,
            { name: def.name, winner, loser: sub.id },
          );
          continue;
        }
        nextOwnership.set(def.name, sub.id);
        aggregated.push(def);
      }
    }
    this.#ownership = nextOwnership;
    this.#shadowed = nextShadowed;
    this.#listed = true;
    return aggregated;
  }

  async execute(
    invocation: ToolInvocation,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (!this.#listed) {
      // Lazy rebuild so execute-before-list still works (hosts that pre-
      // register tools without routing through Agent's sendStream).
      try {
        await this.list();
      } catch (err) {
        return {
          content: `CompositeToolExecutor: list() failed before routing — ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }

    const ownerId = this.#ownership.get(invocation.name);
    if (!ownerId) {
      return {
        content: `CompositeToolExecutor: no sub-executor owns tool "${invocation.name}"`,
        isError: true,
      };
    }
    const sub = this.#subs.find((s) => s.id === ownerId);
    if (!sub) {
      return {
        content: `CompositeToolExecutor: stale ownership for "${invocation.name}" (sub "${ownerId}" missing)`,
        isError: true,
      };
    }
    return sub.executor.execute(invocation, signal);
  }

  /** Diagnostics — which sub owns a given tool name (after list()). */
  ownerOf(toolName: string): string | undefined {
    return this.#ownership.get(toolName);
  }

  /** Diagnostics — tool-name shadowings from the most recent list(). */
  shadowedNames(): readonly ShadowRecord[] {
    return this.#shadowed;
  }
}

interface ShadowRecord {
  name: string;
  winner: string;
  loser: string;
}
