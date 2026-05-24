import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";

export interface MemoSkillOptions {
  tier?: "T0" | "T1" | "T2" | "T3";
  memoDir?: string;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createMemoSkill(opts: MemoSkillOptions = {}): InMemoryToolDef {
  const dir = opts.memoDir ?? path.join(os.homedir(), ".naia", "memos");

  return {
    name: "memo",
    description:
      "Simple key-value memo storage. Save, read, list, and delete short text memos. " +
      "Persisted as flat files on disk.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "read", "list", "delete"],
          description: "Operation to perform.",
        },
        key: {
          type: "string",
          description: "Memo key (used for save, read, delete).",
        },
        content: {
          type: "string",
          description: "Text content (used for save).",
        },
      },
      required: ["action"],
    } as Record<string, unknown>,
    tier: opts.tier ?? "T1",
    handler: (input) => {
      const args = input as {
        action: string;
        key?: string;
        content?: string;
      };

      switch (args.action) {
        case "save": {
          if (!args.key) return "ERROR: key is required for save";
          const key = sanitizeKey(args.key);
          const content = args.content ?? "";
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${key}.txt`), content, "utf-8");
          return `Memo saved: ${key}`;
        }

        case "read": {
          if (!args.key) return "ERROR: key is required for read";
          const key = sanitizeKey(args.key);
          const filePath = path.join(dir, `${key}.txt`);
          if (!fs.existsSync(filePath)) return `ERROR: Memo not found: ${key}`;
          return fs.readFileSync(filePath, "utf-8");
        }

        case "list": {
          if (!fs.existsSync(dir)) return "[]";
          const files = fs.readdirSync(dir);
          const keys = files
            .filter((f) => f.endsWith(".txt"))
            .map((f) => f.replace(/\.txt$/, ""));
          return JSON.stringify(keys);
        }

        case "delete": {
          if (!args.key) return "ERROR: key is required for delete";
          const key = sanitizeKey(args.key);
          const filePath = path.join(dir, `${key}.txt`);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          return `Memo deleted: ${key}`;
        }

        default:
          return `ERROR: Unknown action: ${args.action}`;
      }
    },
  };
}
