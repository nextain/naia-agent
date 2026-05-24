import * as os from "node:os";
import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";

export interface SystemStatusSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
}

export function createSystemStatusSkill(
  opts: SystemStatusSkillOptions = {},
): InMemoryToolDef {
  return {
    name: "system_status",
    description:
      "Get system information: OS, memory, CPU, and uptime. " +
      "Query specific sections (memory, cpu, os) or get everything at once.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "memory", "cpu", "os"],
          description: "Which section to query. Default: all.",
        },
      },
    } as Record<string, unknown>,
    tier: opts.tier ?? "T0",
    handler: (input) => {
      const args = input as { section?: string };
      const section = args.section || "all";

      const getMemory = () => {
        const totalMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMB = Math.round(os.freemem() / 1024 / 1024);
        return { totalMB, freeMB, usedMB: totalMB - freeMB };
      };

      const getCpu = () => {
        const cpus = os.cpus();
        return {
          count: cpus.length,
          model: cpus[0]?.model ?? "unknown",
        };
      };

      const getOs = () => ({
        platform: os.platform(),
        release: os.release(),
        hostname: os.hostname(),
        arch: os.arch(),
      });

      let data: unknown;
      switch (section) {
        case "memory":
          data = getMemory();
          break;
        case "cpu":
          data = getCpu();
          break;
        case "os":
          data = getOs();
          break;
        default:
          data = {
            os: getOs(),
            memory: getMemory(),
            cpus: getCpu(),
            uptime: Math.round(os.uptime()),
          };
          break;
      }

      return JSON.stringify(data, null, 2);
    },
  };
}
