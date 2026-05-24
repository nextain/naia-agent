import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";
import type { SessionManager } from "../session-manager.js";

export interface SessionsSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
  sessionManager: SessionManager;
}

export function createSessionsSkill(
  opts: SessionsSkillOptions,
): InMemoryToolDef {
  const mgr = opts.sessionManager;
  return {
    name: "sessions",
    description:
      "Manage chat sessions: list, create, switch, pause, close, delete. " +
      "Use 'action' to specify the operation.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "switch", "pause", "close", "delete", "current"],
          description: "Session operation. Default: list.",
        },
        sessionId: {
          type: "string",
          description: "Target session ID (for switch/pause/close/delete).",
        },
        title: {
          type: "string",
          description: "Title for a new session (used with 'create').",
        },
      },
      required: ["action"],
    } as Record<string, unknown>,
    tier: opts.tier ?? "T0",
    handler: (input) => {
      const args = input as { action: string; sessionId?: string; title?: string };

      switch (args.action) {
        case "create": {
          const r = mgr.create(args.title);
          return JSON.stringify({ ok: true, session: r }, null, 2);
        }
        case "switch": {
          if (!args.sessionId) return JSON.stringify({ ok: false, error: "sessionId required" });
          try {
            const r = mgr.activate(args.sessionId);
            return JSON.stringify({ ok: true, session: r }, null, 2);
          } catch (err) {
            return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        case "pause": {
          if (!args.sessionId) return JSON.stringify({ ok: false, error: "sessionId required" });
          try {
            const r = mgr.pause(args.sessionId);
            return JSON.stringify({ ok: true, session: r }, null, 2);
          } catch (err) {
            return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        case "close": {
          if (!args.sessionId) return JSON.stringify({ ok: false, error: "sessionId required" });
          try {
            const r = mgr.close(args.sessionId);
            return JSON.stringify({ ok: true, session: r }, null, 2);
          } catch (err) {
            return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        case "delete": {
          if (!args.sessionId) return JSON.stringify({ ok: false, error: "sessionId required" });
          const deleted = mgr.delete(args.sessionId);
          return JSON.stringify({ ok: deleted, sessionId: args.sessionId });
        }
        case "current": {
          const r = mgr.active();
          return JSON.stringify({ ok: true, session: r ?? null }, null, 2);
        }
        default: {
          const sessions = mgr.list();
          return JSON.stringify({ ok: true, count: sessions.length, sessions }, null, 2);
        }
      }
    },
  };
}
