/**
 * SkillToolExecutor — bridges a SkillLoader to the ToolExecutor contract.
 *
 * When wired as `HostContext.tools`, the Agent's LLM sees every skill
 * in the workspace as a tool. Invocation routes through the loader's
 * invoker; the tool `name` is the skill name (1:1).
 *
 * Tier comes from the skill descriptor — no host overrides needed
 * because skill-spec already carries tier semantics.
 */

import type {
  ToolDefinitionWithTier,
  ToolExecutionResult,
  ToolExecutor,
  ToolInvocation,
} from "@nextain/agent-types";
import type { SkillLoader } from "./skill-loader.js";

export interface SkillToolExecutorOptions {
  loader: SkillLoader;
  /** Optional filter — return false to hide a skill from the LLM (e.g.
   *  never expose T3 directly; wrap it behind an approval step). */
  filter?: (name: string) => boolean;
}

export class SkillToolExecutor implements ToolExecutor {
  readonly #loader: SkillLoader;
  readonly #filter: (name: string) => boolean;

  constructor(options: SkillToolExecutorOptions) {
    this.#loader = options.loader;
    this.#filter = options.filter ?? (() => true);
  }

  async list(): Promise<ToolDefinitionWithTier[]> {
    const skills = await this.#loader.list();
    const out: ToolDefinitionWithTier[] = [];
    for (const s of skills) {
      if (!this.#filter(s.name)) continue;
      const def: ToolDefinitionWithTier = {
        name: s.name,
        inputSchema: s.inputSchema,
        tier: s.tier,
      };
      if (s.description) def.description = s.description;
      out.push(def);
    }
    return out;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    try {
      const output = await this.#loader.invoke(invocation.name, {
        args: invocation.input,
        ...(invocation.sessionId !== undefined
          ? { context: { sessionId: invocation.sessionId } }
          : {}),
      });
      const result: ToolExecutionResult = { content: output.content };
      if (output.isError === true) result.isError = true;
      if (output.data !== undefined) result.data = output.data;
      return result;
    } catch (err) {
      return {
        content: `Skill "${invocation.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
