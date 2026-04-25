// Slice 1b sub-6 — Workspace sentinel (D09).
//
// Resolves a relative path against a workspace root and rejects if the
// resolved path escapes the workspace (directory traversal, absolute
// paths, symlink-style ../ sequences).
//
// Source: cleanroom-cc deep-audit F3/F10 fix (matrix B22 — patterns only,
// not code lines). OWASP A01 Path Traversal cross-reference.
// Forbidden_action F09: cleanroom 단독 의존 금지 — this implementation
// follows OWASP/RFC 3986 path normalization, NOT cleanroom code lines.

import { resolve, sep } from "node:path";

export class WorkspaceEscapeError extends Error {
  constructor(
    public readonly attempted: string,
    public readonly workspaceRoot: string,
  ) {
    super(`path escapes workspace: ${attempted} (root=${workspaceRoot})`);
    this.name = "WorkspaceEscapeError";
  }
}

/**
 * Normalize `relativePath` against `workspaceRoot` and ensure the result
 * stays within the workspace.
 *
 * Throws `WorkspaceEscapeError` if:
 *   - resolved path is not within `workspaceRoot` (sentinel `startsWith` check)
 *   - input is an absolute path that escapes
 *
 * Returns the absolute, normalized path inside the workspace.
 */
export function normalizeWorkspacePath(
  relativePath: string,
  workspaceRoot: string,
): string {
  // Guard: workspaceRoot must itself be absolute and exist as a string.
  if (!workspaceRoot || workspaceRoot.length === 0) {
    throw new Error("normalizeWorkspacePath: workspaceRoot is empty");
  }
  // Resolve workspaceRoot first so trailing slashes / .. are normalized.
  const root = resolve(workspaceRoot);
  // Resolve relativePath against root. node:path.resolve handles ../ and
  // absolute inputs (absolute wins, which is the escape case we catch below).
  const resolved = resolve(root, relativePath);
  // Sentinel: must be exactly root, OR start with root + separator. The
  // separator suffix prevents partial-prefix attacks like
  // root="/work" matching "/workmalicious".
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new WorkspaceEscapeError(relativePath, root);
  }
  return resolved;
}
