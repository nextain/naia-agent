import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";
import type { ConfigManager } from "../config-manager.js";

export interface ConfigSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
  configManager: ConfigManager;
}

export function createConfigSkill(opts: ConfigSkillOptions): InMemoryToolDef {
  const mgr = opts.configManager;
  return {
    name: "config",
    description:
      "View or change agent configuration: provider, model, context budget, compaction strategy, language. " +
      "Use 'get' to view, 'set' to change.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set", "reset"],
          description: "Config operation. Default: get.",
        },
        provider: {
          type: "string",
          description: "LLM provider name (e.g. anthropic, openai, nextain, ollama).",
        },
        model: {
          type: "string",
          description: "Model ID (e.g. claude-sonnet-4-6, gpt-4o, gemini-2.5-flash).",
        },
        contextBudget: {
          type: "number",
          description: "Context window budget in tokens.",
        },
        compactionStrategy: {
          type: "string",
          enum: ["reactive", "realtime", "anthropic-native", "off"],
          description: "History compaction strategy.",
        },
        language: {
          type: "string",
          description: "Agent language (BCP 47 tag, e.g. en, ko, ja).",
        },
      },
      required: ["action"],
    } as Record<string, unknown>,
    tier: opts.tier ?? "T1",
    handler: (input) => {
      const args = input as {
        action: string;
        provider?: string;
        model?: string;
        contextBudget?: number;
        compactionStrategy?: string;
        language?: string;
      };

      switch (args.action) {
        case "set": {
          const partial: Record<string, unknown> = {};
          if (args.provider !== undefined) partial.provider = args.provider;
          if (args.model !== undefined) partial.model = args.model;
          if (args.contextBudget !== undefined) partial.contextBudget = args.contextBudget;
          if (args.compactionStrategy !== undefined) partial.compactionStrategy = args.compactionStrategy;
          if (args.language !== undefined) partial.language = args.language;
          const updated = mgr.set(partial);
          return JSON.stringify({ ok: true, config: updated }, null, 2);
        }
        case "reset": {
          const config = mgr.reset();
          return JSON.stringify({ ok: true, config }, null, 2);
        }
        default: {
          const config = mgr.get();
          return JSON.stringify({ ok: true, config }, null, 2);
        }
      }
    },
  };
}
