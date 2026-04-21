import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "@nextain/agent-types";

export interface InMemoryToolDef extends ToolDefinitionWithTier {
  /** Called by execute(). Return the string content to surface back to the LLM. */
  handler: (input: unknown) => Promise<string> | string;
}

/**
 * InMemoryToolExecutor — a trivial ToolExecutor that dispatches to named
 * handler functions. No approval, no OS access. For tests and examples.
 */
export class InMemoryToolExecutor implements ToolExecutor {
  readonly #tools = new Map<string, InMemoryToolDef>();

  constructor(initial: InMemoryToolDef[] = []) {
    for (const t of initial) this.register(t);
  }

  register(def: InMemoryToolDef): void {
    this.#tools.set(def.name, def);
  }

  async list(): Promise<ToolDefinitionWithTier[]> {
    return Array.from(this.#tools.values()).map(
      ({ name, description, inputSchema, tier }) => {
        const def: ToolDefinitionWithTier = { name, inputSchema, tier };
        if (description !== undefined) def.description = description;
        return def;
      },
    );
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(invocation.name);
    if (!tool) {
      return { content: `Tool "${invocation.name}" not found`, isError: true };
    }
    try {
      const content = await tool.handler(invocation.input);
      return { content };
    } catch (err) {
      return {
        content: `Tool "${invocation.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
