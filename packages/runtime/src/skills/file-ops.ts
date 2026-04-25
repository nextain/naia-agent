// Slice 2.6 — File ops skills (read/write/edit/list_files).
//
// All skills enforce workspace boundary via D09 (normalizeWorkspacePath).
// Tier T0 = read-only, T1 = writes (callers should pre-confirm or gate).
//
// Output format: handler returns string. Errors return "ERROR:" prefix
// (Agent forwards to LLM as tool result).

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, relative, join } from "node:path";
import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";
import type { Logger } from "@nextain/agent-types";
import {
  normalizeWorkspacePath,
  WorkspaceEscapeError,
} from "../utils/path-normalize.js";

export interface FileOpsOptions {
  /** Workspace root. All paths resolved relative to this. Default: cwd at call. */
  workspaceRoot?: string;
  /** Max bytes per file read/write. Default 256 KB. */
  maxBytes?: number;
  /** Optional logger — file ops will emit debug enter/branch/exit traces. */
  logger?: Logger;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

function resolveRoot(opts: FileOpsOptions): string {
  return opts.workspaceRoot ?? process.cwd();
}

async function safePath(rel: string, opts: FileOpsOptions): Promise<string> {
  const root = resolveRoot(opts);
  return normalizeWorkspacePath(rel, root);
}

// ─────────────────────────────────────────────────────────────────────────
// read_file (T0)
// ─────────────────────────────────────────────────────────────────────────
export function createReadFileSkill(opts: FileOpsOptions = {}): InMemoryToolDef {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Returns file content (truncated to maxBytes if larger). Path is workspace-relative.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "workspace-relative path" } },
      required: ["path"],
    } as Record<string, unknown>,
    tier: "T0",
    isConcurrencySafe: true,
    handler: async (input) => {
      const { path } = input as { path: string };
      const fn = opts.logger?.fn?.("read_file.handler", { path });
      if (typeof path !== "string" || !path.trim()) {
        fn?.branch("invalid-path");
        return fn?.exit("ERROR: read_file requires `path`") ?? "ERROR: read_file requires `path`";
      }
      try {
        const abs = await safePath(path, opts);
        const buf = await readFile(abs);
        if (buf.length > max) {
          fn?.branch("truncated", { fullSize: buf.length, maxBytes: max });
          const out = buf.subarray(0, max).toString("utf8") + `\n[truncated to ${max} bytes — full size ${buf.length}]`;
          return fn?.exit({ size: max, truncated: true }) ? out : out;
        }
        fn?.exit({ size: buf.length });
        return buf.toString("utf8");
      } catch (e) {
        if (e instanceof WorkspaceEscapeError) {
          fn?.branch("workspace-escape");
          opts.logger?.warn("security.path_escape", { attempted: path });
          return fn?.exit(`BLOCKED: ${e.message}`) ?? `BLOCKED: ${e.message}`;
        }
        fn?.branch("error", { msg: (e as Error).message });
        return fn?.exit(`ERROR: ${(e as Error).message}`) ?? `ERROR: ${(e as Error).message}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// write_file (T1)
// ─────────────────────────────────────────────────────────────────────────
export function createWriteFileSkill(opts: FileOpsOptions = {}): InMemoryToolDef {
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    name: "write_file",
    description:
      "Write a UTF-8 text file in the workspace. Creates parent directories if needed. Overwrites existing files. Path is workspace-relative.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "workspace-relative path" },
        content: { type: "string", description: "file content (UTF-8 text)" },
      },
      required: ["path", "content"],
    } as Record<string, unknown>,
    tier: "T1",
    isDestructive: true,
    isConcurrencySafe: false,
    handler: async (input) => {
      const { path, content } = input as { path: string; content: string };
      const fn = opts.logger?.fn?.("write_file.handler", { path, contentLen: typeof content === "string" ? content.length : 0 });
      if (typeof path !== "string" || !path.trim()) { fn?.exit("ERROR"); return "ERROR: write_file requires `path`"; }
      if (typeof content !== "string") { fn?.exit("ERROR"); return "ERROR: write_file requires `content` (string)"; }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > max) { fn?.branch("size-exceeded"); fn?.exit("ERROR"); return `ERROR: content exceeds maxBytes (${bytes} > ${max})`; }
      try {
        const abs = await safePath(path, opts);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        const out = `wrote ${bytes} bytes → ${relative(resolveRoot(opts), abs)}`;
        return fn?.exit({ bytes }) ? out : out;
      } catch (e) {
        if (e instanceof WorkspaceEscapeError) { fn?.branch("workspace-escape"); opts.logger?.warn("security.path_escape", { attempted: path }); return fn?.exit(`BLOCKED`) ? `BLOCKED: ${e.message}` : `BLOCKED: ${e.message}`; }
        fn?.branch("error"); return fn?.exit(`ERROR`) ? `ERROR: ${(e as Error).message}` : `ERROR: ${(e as Error).message}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// edit_file (T1) — exact-match find/replace (single occurrence by default)
// ─────────────────────────────────────────────────────────────────────────
export function createEditFileSkill(opts: FileOpsOptions = {}): InMemoryToolDef {
  return {
    name: "edit_file",
    description:
      "Edit a text file by exact-match find/replace. Default replaces ONE occurrence; set replaceAll=true for all. " +
      "Returns count of replacements. Use this for surgical edits — for full overwrite use write_file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string", description: "exact text to find (verbatim, no regex)" },
        replace: { type: "string", description: "replacement text" },
        replaceAll: { type: "boolean", description: "replace all occurrences (default false)" },
      },
      required: ["path", "find", "replace"],
    } as Record<string, unknown>,
    tier: "T1",
    isDestructive: true,
    isConcurrencySafe: false,
    handler: async (input) => {
      const { path, find, replace, replaceAll } = input as {
        path: string;
        find: string;
        replace: string;
        replaceAll?: boolean;
      };
      const fn = opts.logger?.fn?.("edit_file.handler", { path, replaceAll: !!replaceAll });
      if (!path?.trim()) { fn?.exit("ERROR"); return "ERROR: edit_file requires `path`"; }
      if (typeof find !== "string" || find.length === 0) { fn?.exit("ERROR"); return "ERROR: edit_file requires non-empty `find`"; }
      if (typeof replace !== "string") { fn?.exit("ERROR"); return "ERROR: edit_file requires `replace` (string)"; }
      try {
        const abs = await safePath(path, opts);
        const original = await readFile(abs, "utf8");
        let updated: string;
        let count: number;
        if (replaceAll) {
          fn?.branch("replace-all");
          const parts = original.split(find);
          count = parts.length - 1;
          updated = parts.join(replace);
        } else {
          fn?.branch("replace-single");
          const idx = original.indexOf(find);
          if (idx === -1) { fn?.exit("not-found"); return `ERROR: find pattern not found in ${relative(resolveRoot(opts), abs)}`; }
          updated = original.slice(0, idx) + replace + original.slice(idx + find.length);
          count = 1;
        }
        if (count === 0) { fn?.exit("no-change"); return `no changes — find pattern not present`; }
        await writeFile(abs, updated, "utf8");
        const out = `edited ${relative(resolveRoot(opts), abs)} (${count} replacement${count > 1 ? "s" : ""})`;
        return fn?.exit({ count }) ? out : out;
      } catch (e) {
        if (e instanceof WorkspaceEscapeError) { fn?.branch("workspace-escape"); opts.logger?.warn("security.path_escape", { attempted: path }); return fn?.exit(`BLOCKED`) ? `BLOCKED: ${e.message}` : `BLOCKED: ${e.message}`; }
        fn?.branch("error"); return fn?.exit(`ERROR`) ? `ERROR: ${(e as Error).message}` : `ERROR: ${(e as Error).message}`;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// list_files (T0)
// ─────────────────────────────────────────────────────────────────────────
export function createListFilesSkill(opts: FileOpsOptions = {}): InMemoryToolDef {
  return {
    name: "list_files",
    description:
      "List entries in a workspace directory (non-recursive). Returns one entry per line with type ([d] directory, [f] file, [l] symlink) and name.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "workspace-relative directory (default: '.')" },
      },
      required: [],
    } as Record<string, unknown>,
    tier: "T0",
    isConcurrencySafe: true,
    handler: async (input) => {
      const { path = "." } = (input ?? {}) as { path?: string };
      const fn = opts.logger?.fn?.("list_files.handler", { path });
      try {
        const abs = await safePath(path, opts);
        const entries = await readdir(abs);
        const lines: string[] = [];
        for (const e of entries) {
          try {
            const s = await stat(join(abs, e));
            const type = s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : "f";
            lines.push(`[${type}] ${e}`);
          } catch {
            lines.push(`[?] ${e}`);
          }
        }
        const out = lines.length > 0 ? lines.join("\n") : "(empty directory)";
        return fn?.exit({ entries: lines.length }) ? out : out;
      } catch (e) {
        if (e instanceof WorkspaceEscapeError) { fn?.branch("workspace-escape"); opts.logger?.warn("security.path_escape", { attempted: path }); return fn?.exit(`BLOCKED`) ? `BLOCKED: ${e.message}` : `BLOCKED: ${e.message}`; }
        fn?.branch("error"); return fn?.exit(`ERROR`) ? `ERROR: ${(e as Error).message}` : `ERROR: ${(e as Error).message}`;
      }
    },
  };
}

/**
 * Convenience: returns all four file-ops skills in one call.
 */
export function createFileOpsSkills(opts: FileOpsOptions = {}): InMemoryToolDef[] {
  return [
    createReadFileSkill(opts),
    createWriteFileSkill(opts),
    createEditFileSkill(opts),
    createListFilesSkill(opts),
  ];
}
