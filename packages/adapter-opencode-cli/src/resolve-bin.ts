import { execSync } from "node:child_process";
import { isAbsolute } from "node:path";

/**
 * Resolve opencode binary:
 *   1. process.env.OPENCODE_BIN (explicit; validated absolute path, P0-2)
 *   2. system PATH via `where`/`which` (cross-platform, P2-3)
 *   3. fallback: ["npx", "opencode-ai@1.14.25"]
 */
export interface ResolvedBin {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/**
 * Validate OPENCODE_BIN env var (P0-2).
 * Throws if the value contains null bytes or is not absolute.
 * Returns the trimmed value, or undefined if unset/empty.
 */
function validateOpencodeBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  // Reject null bytes (common injection vector)
  if (trimmed.includes("\0")) {
    throw new Error(
      `OPENCODE_BIN contains null byte — refusing to spawn (P0 injection guard)`,
    );
  }
  // Require absolute path to prevent relative-path hijacking
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `OPENCODE_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/opencode`,
    );
  }
  return trimmed;
}

/** Cross-platform PATH lookup for opencode. Returns command string or null. */
function findInPath(): string | null {
  const cmd = process.platform === "win32" ? `where opencode` : `which opencode`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // `where` on Windows may return multiple lines; take the first
    const first = result.split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

export function resolveOpencodeBin(): ResolvedBin {
  const validated = validateOpencodeBin(process.env["OPENCODE_BIN"]);
  if (validated) {
    return { command: validated, prefixArgs: [] };
  }
  const inPath = findInPath();
  if (inPath) {
    return { command: inPath, prefixArgs: [] };
  }
  return { command: "npx", prefixArgs: ["--yes", "opencode-ai@1.14.25"] };
}
