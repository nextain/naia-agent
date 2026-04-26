import { execSync } from "node:child_process";

/**
 * Resolve opencode binary:
 *   1. process.env.OPENCODE_BIN (explicit)
 *   2. system PATH `which opencode`
 *   3. fallback: ["npx", "opencode-ai@1.14.25"]
 */
export interface ResolvedBin {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export function resolveOpencodeBin(): ResolvedBin {
  const envBin = process.env["OPENCODE_BIN"];
  if (envBin && envBin.length > 0) {
    return { command: envBin, prefixArgs: [] };
  }
  try {
    const where = execSync("command -v opencode", { encoding: "utf8" }).trim();
    if (where.length > 0) {
      return { command: where, prefixArgs: [] };
    }
  } catch {
    // not in PATH
  }
  return { command: "npx", prefixArgs: ["--yes", "opencode-ai@1.14.25"] };
}
