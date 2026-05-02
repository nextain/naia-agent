// Slice 3 — Coding CLI tool (T2).
//
// Wraps Claude Code in-process via ai-sdk-provider-claude-code + VercelClient.
// Registered in InMemoryToolExecutor as a T2 ToolDefinition — stateless
// request/response (not SubAgentAdapter). Requires ApprovalBroker for T2.
//
// Architect review: ToolExecutor path preferred over SubAgentAdapter for
// coding CLIs (stateless; no session lifecycle needed).
// Reference: ai-sdk-provider-claude-code uses @anthropic-ai/claude-agent-sdk
// query() in-process, NOT `claude --print` subprocess.

import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";

export interface CodingSkillOptions {
  /** Claude model ID (default: claude-haiku-4-5-20251001). */
  modelId?: string;
  /** Max output bytes returned to the agent (default: 32_768 = 32 KB). */
  maxOutputBytes?: number;
  /** Tier label (default T2). T2 requires ApprovalBroker in production. */
  tier?: "T1" | "T2" | "T3";
}

export interface CodingInput {
  /** Coding task description. Be specific: file to edit, what to change, expected outcome. */
  task: string;
  /** Absolute working directory for the coding session. Defaults to process.cwd(). */
  workdir?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_OUTPUT = 32_768;

/**
 * Create the `code` tool. Register in your InMemoryToolExecutor:
 *   const tools = new InMemoryToolExecutor([createCodingSkill()]);
 *
 * LLM sees:
 *   { name: "code", description: "...", inputSchema: { task: string, workdir?: string } }
 *
 * On execute: calls Claude Code in-process via VercelClient + createClaudeCode().
 * Requires ANTHROPIC_API_KEY in environment.
 * Output is bounded to maxOutputBytes (default 32 KB).
 */
export function createCodingSkill(opts: CodingSkillOptions = {}): InMemoryToolDef {
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const tier = opts.tier ?? "T2";

  return {
    name: "code",
    description:
      "Run a focused coding task using Claude Code in-process. " +
      "Provide a precise task: which file(s) to create/edit, what the change should accomplish, " +
      "and any relevant context. Claude Code will write/edit files and return a summary. " +
      "Use for code generation, refactoring, and targeted file edits only — " +
      "not for research or multi-step planning (use the agent loop for that).",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Precise coding task. Include: file path(s), what to change, and success criteria.",
        },
        workdir: {
          type: "string",
          description:
            "Absolute path to the working directory. Defaults to process.cwd().",
        },
      },
      required: ["task"],
    } as Record<string, unknown>,
    tier,
    isDestructive: true,
    isConcurrencySafe: false,
    handler: async (input) => {
      const { task, workdir } = input as CodingInput;

      if (typeof task !== "string" || task.trim().length === 0) {
        return "ERROR: coding-tool requires a non-empty `task` string.";
      }

      const cwd = workdir ?? process.cwd();
      const systemNote = `Working directory: ${cwd}`;

      let text: string;
      try {
        // Dynamic import keeps ai-sdk-provider-claude-code optional at module
        // load time — only required when the tool is actually invoked.
        const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
        const { VercelClient } = await import("@nextain/agent-providers");

        const provider = createClaudeCode();
        const model = provider(modelId as Parameters<typeof provider>[0]);
        const client = new VercelClient(model);

        const response = await client.generate({
          model: modelId,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `${systemNote}\n\n${task.trim()}` }],
            },
          ],
        });

        text = response.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `ERROR: coding-tool failed — ${msg}`;
      }

      if (!text || text.trim().length === 0) return "[no output]";
      if (text.length > maxOutputBytes) {
        return text.slice(0, maxOutputBytes) + `\n[truncated to ${maxOutputBytes} bytes]`;
      }
      return text;
    },
  };
}
