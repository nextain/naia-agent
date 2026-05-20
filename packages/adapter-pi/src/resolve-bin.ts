import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve pi binary:
 *   1. PI_BIN env var (explicit; validated absolute path)
 *   2. workspace-local node_modules (hoisted pnpm store)
 *   3. system PATH via `where`/`which` (cross-platform)
 *   4. fallback: ["npx", "--yes", "@earendil-works/pi-coding-agent"]
 */
export interface ResolvedBin {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

function validatePiBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) {
    throw new Error(
      `PI_BIN contains null byte — refusing to spawn (injection guard)`,
    );
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `PI_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/pi`,
    );
  }
  return trimmed;
}

/** Look for pi in workspace-local node_modules (handles pnpm hoisting). */
function findInNodeModules(): string | null {
  // Walk up from this file's location to find node_modules.
  // fileURLToPath handles file:///C:/... correctly on Windows.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/resolve-bin.js → ../../.. = repo root node_modules
    resolve(thisDir, "../../../node_modules/.bin/pi"),
    resolve(thisDir, "../../../../node_modules/.bin/pi"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Cross-platform PATH lookup for pi. Returns command string or null. */
function findInPath(): string | null {
  const cmd = process.platform === "win32" ? `where pi` : `which pi`;
  try {
    const result = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const first = result.split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

export function resolvePiBin(): ResolvedBin {
  const validated = validatePiBin(process.env["PI_BIN"]);
  if (validated) {
    return { command: validated, prefixArgs: [] };
  }
  const inNodeModules = findInNodeModules();
  if (inNodeModules) {
    return { command: inNodeModules, prefixArgs: [] };
  }
  const inPath = findInPath();
  if (inPath) {
    return { command: inPath, prefixArgs: [] };
  }
  // npx fallback — installs on first use if not present
  return { command: "npx", prefixArgs: ["--yes", "@earendil-works/pi-coding-agent"] };
}
