import * as os from "node:os";
import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";
import type { SessionManager } from "../session-manager.js";
import type { ConfigManager } from "../config-manager.js";

export interface DiagnosticsSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
  sessionManager?: SessionManager;
  configManager?: ConfigManager;
  startedAt?: number;
}

export function createDiagnosticsSkill(
  opts: DiagnosticsSkillOptions = {},
): InMemoryToolDef {
  const startedAt = opts.startedAt ?? Date.now();
  return {
    name: "diagnostics",
    description:
      "Get agent diagnostics: session stats, system resources, token usage, config state. " +
      "Query sections: agent, system, config, all.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "agent", "system", "config"],
          description: "Which section to query. Default: all.",
        },
      },
    } as Record<string, unknown>,
    tier: opts.tier ?? "T0",
    handler: (input) => {
      const args = input as { section?: string };
      const section = args.section || "all";

      const getAgent = () => {
        const active = opts.sessionManager?.active();
        const sessions = opts.sessionManager?.list() ?? [];
        return {
          uptime: Math.round((Date.now() - startedAt) / 1000),
          activeSession: active
            ? { id: active.id, turnCount: active.turnCount, tokens: { in: active.totalInputTokens, out: active.totalOutputTokens } }
            : null,
          totalSessions: sessions.length,
          sessions: sessions.map((s) => ({
            id: s.id,
            state: s.state,
            turns: s.turnCount,
            title: s.title,
          })),
        };
      };

      const getSystem = () => {
        const mem = process.memoryUsage();
        return {
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          nodeVersion: process.version,
          memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            systemFreeMB: Math.round(os.freemem() / 1024 / 1024),
            systemTotalMB: Math.round(os.totalmem() / 1024 / 1024),
          },
          cpuCount: os.cpus().length,
          systemUptime: Math.round(os.uptime()),
        };
      };

      const getConfig = () => {
        const cfg = opts.configManager?.get();
        return cfg ?? { note: "ConfigManager not wired" };
      };

      let data: unknown;
      switch (section) {
        case "agent":
          data = getAgent();
          break;
        case "system":
          data = getSystem();
          break;
        case "config":
          data = getConfig();
          break;
        default:
          data = { agent: getAgent(), system: getSystem(), config: getConfig() };
          break;
      }

      return JSON.stringify(data, null, 2);
    },
  };
}
