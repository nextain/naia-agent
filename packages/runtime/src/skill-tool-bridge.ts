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
  /**
   * Optional filter — return false to HIDE a skill from the LLM AND to
   * refuse `execute()` even if the name is somehow invoked (replay,
   * crafted tool_use). Treat as a security boundary.
   */
  filter?: (name: string) => boolean;
  /**
   * Optional name prefix — every skill's tool name becomes `${prefix}:${name}`.
   * Use this when mixing with other ToolExecutors (e.g. MCPToolExecutor)
   * to avoid name collisions. Empty string (default) = no prefix.
   */
  namePrefix?: string;
  /**
   * Optional context forwarding — additional {key: value} pairs merged
   * into SkillInput.context alongside `sessionId`. Lets hosts supply
   * `project`, `activeFile`, etc. without modifying the invocation.
   */
  contextExtras?: () => Record<string, string>;
  /**
   * Optional error sanitizer — scrubs secrets/paths from error messages
   * before surfacing to the LLM. Default: pass through.
   */
  sanitizeError?: (message: string) => string;
}

export class SkillToolExecutor implements ToolExecutor {
  readonly #loader: SkillLoader;
  readonly #filter: (name: string) => boolean;
  readonly #prefix: string;
  readonly #contextExtras?: () => Record<string, string>;
  readonly #sanitize: (s: string) => string;

  constructor(options: SkillToolExecutorOptions) {
    this.#loader = options.loader;
    this.#filter = options.filter ?? (() => true);
    this.#prefix = options.namePrefix ?? "";
    if (options.contextExtras) this.#contextExtras = options.contextExtras;
    this.#sanitize = options.sanitizeError ?? ((s) => s);
  }

  async list(): Promise<ToolDefinitionWithTier[]> {
    // Note: SkillLoader implementations (e.g. FileSkillLoader) should
    // cache their result. Agent calls list() per tool-hop; without a
    // cache this would rescan the workspace every iteration.
    const skills = await this.#loader.list();
    const out: ToolDefinitionWithTier[] = [];
    for (const s of skills) {
      if (!this.#filter(s.name)) continue;
      const def: ToolDefinitionWithTier = {
        name: this.#toolNameFor(s.name),
        inputSchema: s.inputSchema,
        tier: s.tier,
      };
      if (s.description) def.description = s.description;
      out.push(def);
    }
    return out;
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const skillName = this.#skillNameFor(invocation.name);
    if (skillName === null) {
      return {
        content: `SkillToolExecutor: name "${invocation.name}" does not match prefix "${this.#prefix}"`,
        isError: true,
      };
    }
    // Filter enforcement: LLM replay or crafted tool_use cannot bypass
    // the filter (it is a security boundary per option docs).
    if (!this.#filter(skillName)) {
      return {
        content: `Skill "${skillName}" is not available`,
        isError: true,
      };
    }
    try {
      const context: Record<string, string> = {};
      if (invocation.sessionId !== undefined) context["sessionId"] = invocation.sessionId;
      if (this.#contextExtras) Object.assign(context, this.#contextExtras());
      const output = await this.#loader.invoke(skillName, {
        args: invocation.input,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      });
      const result: ToolExecutionResult = { content: output.content };
      if (output.isError === true) result.isError = true;
      if (output.data !== undefined) result.data = output.data;
      return result;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return {
        content: `Skill "${skillName}" threw: ${this.#sanitize(raw)}`,
        isError: true,
      };
    }
  }

  #toolNameFor(skillName: string): string {
    return this.#prefix === "" ? skillName : `${this.#prefix}:${skillName}`;
  }

  #skillNameFor(toolName: string): string | null {
    if (this.#prefix === "") return toolName;
    const p = `${this.#prefix}:`;
    if (!toolName.startsWith(p)) return null;
    return toolName.slice(p.length);
  }
}
