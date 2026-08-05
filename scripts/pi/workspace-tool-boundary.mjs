import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const WORKSPACE_PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export function workspaceToolPathViolation(cwd, input) {
  if (typeof cwd !== "string" || cwd.length === 0) return "workspace root is unavailable";
  const raw = input && typeof input === "object" ? input.path : undefined;
  if (raw !== undefined && typeof raw !== "string") return "tool path must be a string";
  const root = realpathSync(cwd);
  // Pi's built-in file tools remove one leading `@` before resolving a path.
  // Apply the same normalization here so the guard evaluates the exact target
  // that the tool will use (for example, `@/etc/passwd` remains absolute).
  const normalized = raw?.startsWith("@") ? raw.slice(1) : raw;
  const target = resolve(root, normalized && normalized.length > 0 ? normalized : ".");
  if (!isWithin(root, target)) return "tool path escapes the assigned workspace";
  const existing = nearestExisting(target);
  if (!isWithin(root, realpathSync(existing))) return "tool path escapes through a symbolic link";
  if (existsSync(target) && !isWithin(root, realpathSync(target))) {
    return "tool target escapes through a symbolic link";
  }
  return undefined;
}

function nearestExisting(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`no existing ancestor for tool path: ${path}`);
    current = parent;
  }
  return current;
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
