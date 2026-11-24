// adapters/browser-read-tools — 브라우저 환경용 ADK 읽기 도구 실행기 (FE-21).
import type { ToolSpec, ToolCall, ToolExecutionResult } from "../domain/chat.js";
import type { ToolExecutorPort } from "../ports/uc1.js";
import { isSensitivePath } from "../domain/fs-sandbox.js";

export type BrowserReadStat =
  | { readonly kind: "file"; readonly size: number }
  | { readonly kind: "directory" }
  | null;

export interface BrowserReadEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}

export interface BrowserReadFs {
  stat(segments: readonly string[]): Promise<BrowserReadStat>; // [] = 작업 공간 맨 위
  list(segments: readonly string[]): Promise<readonly BrowserReadEntry[]>; // 폴더일 때만 부른다
  readText(segments: readonly string[]): Promise<string>; // 1MB 이하 파일일 때만 부른다
}

export const BROWSER_READ_TOOL_NAMES: readonly ["list_dir", "read_file"] = [
  "list_dir",
  "read_file",
] as const;

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function norm(x: string): string {
  return x.toLowerCase().replace(/^\.+/, "");
}

function isHiddenEntry(parentSegments: readonly string[], name: string): boolean {
  const childSegments = [...parentSegments, name];
  if (childSegments.length > 0 && childSegments[0]!.toLowerCase() === "naia-settings") {
    return true;
  }
  if (isSensitivePath("/" + childSegments.join("/"))) {
    return true;
  }
  return false;
}

type PathValidation =
  | { readonly ok: true; readonly originalPath: string; readonly segments: readonly string[] }
  | { readonly ok: false; readonly output: string };

function validatePath(rawPath: unknown): PathValidation {
  if (typeof rawPath !== "string") {
    return { ok: false, output: "invalid arguments: path must be a string" };
  }

  const originalPath = rawPath.trim();

  if (
    originalPath === "" ||
    originalPath === "." ||
    originalPath === "/" ||
    originalPath === "./" ||
    originalPath === "opfs://naia-adk" ||
    originalPath === "opfs://naia-adk/"
  ) {
    return { ok: true, originalPath, segments: [] };
  }

  let candidate: string;
  if (originalPath.startsWith("opfs://naia-adk")) {
    const rest = originalPath.slice("opfs://naia-adk".length);
    if (rest !== "" && !rest.startsWith("/")) {
      return { ok: false, output: "denied: absolute paths are not allowed" };
    }
    candidate = rest;
  } else {
    if (
      originalPath.startsWith("/") ||
      originalPath.includes("://") ||
      /^[A-Za-z]:/.test(originalPath)
    ) {
      return { ok: false, output: "denied: absolute paths are not allowed" };
    }
    candidate = originalPath;
  }

  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (candidate[i] === "\\" || (code >= 0 && code <= 31) || code === 127) {
      return { ok: false, output: "denied: path outside workspace" };
    }
  }

  const segments = candidate.split("/").filter((s) => s.length > 0 && s !== ".");

  if (segments.includes("..")) {
    return { ok: false, output: "denied: path outside workspace" };
  }

  if (segments.length > 0 && segments[0]!.toLowerCase() === "naia-settings") {
    return { ok: false, output: "denied: settings folder is not readable" };
  }

  if (isSensitivePath("/" + segments.join("/"))) {
    return { ok: false, output: "denied: sensitive path" };
  }

  return { ok: true, originalPath, segments };
}

async function handleNotFound(
  fs: BrowserReadFs,
  originalPath: string,
  segments: readonly string[],
): Promise<ToolExecutionResult> {
  let firstMissingIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const sub = segments.slice(0, i + 1);
    const s = await fs.stat(sub);
    if (s === null) {
      firstMissingIdx = i;
      break;
    } else if (s.kind === "file" && i < segments.length - 1) {
      const filePrefixPath = segments.slice(0, i + 1).join("/");
      return {
        output: `not found: ${originalPath}. ${filePrefixPath} is a file`,
        isError: true,
      };
    }
  }

  if (firstMissingIdx === -1) {
    firstMissingIdx = Math.max(0, segments.length - 1);
  }

  const k = firstMissingIdx;
  const parentSegments = segments.slice(0, k);
  const targetSegment = segments[k] ?? "";

  const parentEntries = await fs.list(parentSegments);
  const visible = parentEntries
    .filter((e) => !isHiddenEntry(parentSegments, e.name))
    .sort((a, b) => compareNames(a.name, b.name));

  const targetNorm = norm(targetSegment);
  const matched = visible.find((e) => norm(e.name) === targetNorm);

  if (matched) {
    const correctedSegments = [
      ...segments.slice(0, k),
      matched.name,
      ...segments.slice(k + 1),
    ];
    const correctedStat = await fs.stat(correctedSegments);
    if (correctedStat !== null) {
      const correctedPath = correctedSegments.join("/");
      return {
        output: `not found: ${originalPath}. Did you mean: ${correctedPath}?`,
        isError: true,
      };
    }
  }

  const parentLabel = parentSegments.length === 0 ? "/" : parentSegments.join("/");
  const entriesStr = visible
    .slice(0, 30)
    .map((e) => (e.kind === "directory" ? `${e.name}/` : e.name))
    .join(", ");

  return {
    output: `not found: ${originalPath}. Entries in ${parentLabel}: ${entriesStr}`,
    isError: true,
  };
}

export function makeBrowserReadTools(deps: { fs: BrowserReadFs }): ToolExecutorPort {
  const toolSpecs: readonly ToolSpec[] = [
    {
      name: "list_dir",
      description:
        "List files and folders at a path in the user's ADK workspace. Each line is \"d <path>\" for a folder or \"f <path>\" for a file, where <path> is the full path from the workspace root. Pass that path unchanged to read_file or list_dir.",
      tier: "none",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the workspace root, for example AGENTS.md or notes/hello.md. Use exact names; hidden folders start with a dot.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description:
        "Read a text file in the user's ADK workspace. Use the full path from the workspace root, exactly as list_dir shows it.",
      tier: "none",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the workspace root, for example AGENTS.md or notes/hello.md. Use exact names; hidden folders start with a dot.",
          },
        },
        required: ["path"],
      },
    },
  ];

  return {
    specs(): readonly ToolSpec[] {
      return toolSpecs;
    },

    async execute(
      call: ToolCall,
      opts: { signal?: AbortSignal; requestId?: string },
    ): Promise<ToolExecutionResult> {
      if (opts.signal?.aborted) {
        throw new Error("aborted");
      }

      if (call.name !== "list_dir" && call.name !== "read_file") {
        return { output: `unknown tool: ${call.name}`, isError: true };
      }

      const rawPath = (call.args as Record<string, unknown> | null | undefined)?.path;
      const validation = validatePath(rawPath);
      if (!validation.ok) {
        return { output: validation.output, isError: true };
      }

      const { originalPath, segments } = validation;

      try {
        if (call.name === "list_dir") {
          const stat = await deps.fs.stat(segments);
          if (stat === null) {
            return await handleNotFound(deps.fs, originalPath, segments);
          }
          if (stat.kind === "file") {
            return { output: `not a directory: ${originalPath}`, isError: true };
          }

          const rawEntries = await deps.fs.list(segments);
          const visible = rawEntries
            .filter((e) => !isHiddenEntry(segments, e.name))
            .sort((a, b) => compareNames(a.name, b.name));

          if (visible.length === 0) {
            return { output: "(empty)" };
          }

          const lines = visible.slice(0, 200).map((e) => {
            const prefix = e.kind === "directory" ? "d" : "f";
            const fullPath = segments.length > 0 ? `${segments.join("/")}/${e.name}` : e.name;
            return `${prefix} ${fullPath}`;
          });

          if (visible.length > 200) {
            lines.push("…(more entries)");
          }

          return { output: lines.join("\n") };
        } else {
          // read_file
          const stat = await deps.fs.stat(segments);
          if (stat === null) {
            return await handleNotFound(deps.fs, originalPath, segments);
          }
          if (stat.kind === "directory") {
            return { output: `not a file: ${originalPath}`, isError: true };
          }

          if (stat.size > 1048576) {
            return { output: "file too large", isError: true };
          }

          const text = await deps.fs.readText(segments);
          if (text.length > 6000) {
            return {
              output: text.slice(0, 6000) + `\n…(truncated, ${text.length} chars)`,
            };
          }

          return { output: text };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `error: ${msg}`, isError: true };
      }
    },
  };
}
