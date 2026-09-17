// domain/workspace-bind — host workspace root + terminal grant as one Codex/fs-tools bound.
//
// After Naia write/shell tools were removed, file and terminal work goes through Codex CLI.
// The shell already canonicalizes the selected root (`set_root`). This module is the
// single policy for that root: Codex app-server cwd/sandbox and fs-tools allow-root
// must not invent a second sandbox (OS temp) or a second grant.
//
// Pure: no I/O. Canonicalization/existence is the host adapter's job.

export type FilesystemAccess = "read-only" | "workspace-write";

export interface WorkspaceBind {
  readonly canonicalRoot: string;
  readonly filesystemAccess: FilesystemAccess;
}

export interface WorkspaceBindInput {
  readonly canonicalRoot: string;
  readonly terminalAllowed?: boolean;
}

export function resolveWorkspaceBind(input: WorkspaceBindInput): WorkspaceBind | undefined {
  if (typeof input.canonicalRoot !== "string") return undefined;
  const canonicalRoot = input.canonicalRoot.trim();
  if (!canonicalRoot) return undefined;
  return {
    canonicalRoot,
    filesystemAccess: input.terminalAllowed === true ? "workspace-write" : "read-only",
  };
}

/** Settings projection: `environmentTerminalInput` is the shell "allow typing into your terminal" grant. */
export function workspaceBindFromSettings(input: {
  canonicalRoot: string;
  environmentTerminalInput?: unknown;
}): WorkspaceBind | undefined {
  return resolveWorkspaceBind({
    canonicalRoot: input.canonicalRoot,
    terminalAllowed: input.environmentTerminalInput === true,
  });
}

export function codexThreadWorkspace(
  bind: WorkspaceBind | undefined,
  fallbackCwd: string,
): { readonly cwd: string; readonly sandbox: FilesystemAccess } {
  if (!bind) return { cwd: fallbackCwd, sandbox: "read-only" };
  return { cwd: bind.canonicalRoot, sandbox: bind.filesystemAccess };
}
