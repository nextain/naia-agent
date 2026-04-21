/**
 * FileSkillLoader — reads naia-adk workspace format from disk.
 *
 * Implements `SkillLoader` (shape from `@naia-adk/skill-spec`). Scans
 * `<workspaceRoot>/.agents/skills/<name>/SKILL.md` and parses YAML
 * front-matter via a tiny in-place parser (no YAML dep — SKILL.md front-
 * matter is a subset: `key: value` / `key: [a, b]` / simple strings).
 *
 * Invocation is left to the host: `invoke()` throws unless an invoker
 * function is injected. That decouples the loader (pure parse) from the
 * runtime side (how to actually execute a skill — shell cmd, LLM call,
 * sub-agent …).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Shape mirrors `@naia-adk/skill-spec` — kept local to avoid cross-repo
 *  runtime dep. When skill-spec publishes to npm we can import directly. */
export interface SkillDescriptor {
  name: string;
  description: string;
  version: string;
  tier: "T0" | "T1" | "T2" | "T3";
  inputSchema: Record<string, unknown>;
  sourcePath?: string;
  author?: string;
  tags?: string[];
}

export interface SkillInput {
  args: unknown;
  context?: Record<string, string>;
}

export interface SkillOutput {
  content: string;
  data?: unknown;
  isError?: boolean;
}

export interface SkillLoader {
  list(): Promise<SkillDescriptor[]>;
  get(name: string): Promise<SkillDescriptor | null>;
  invoke(name: string, input: SkillInput): Promise<SkillOutput>;
}

export interface FileSkillLoaderOptions {
  /** Workspace root (directory containing `.agents/`). */
  workspaceRoot: string;
  /**
   * Host-supplied invoker — runs the skill's body. If omitted, `invoke()`
   * returns an isError result telling the caller the loader is parse-only.
   */
  invoker?: (descriptor: SkillDescriptor, input: SkillInput) => Promise<SkillOutput>;
}

/**
 * FileSkillLoader — scans `<workspaceRoot>/.agents/skills/*` for skill
 * directories each containing a `SKILL.md`. Descriptors parsed from
 * YAML front-matter. Caches result until `reload()` is called.
 */
export class FileSkillLoader implements SkillLoader {
  readonly #root: string;
  readonly #invoker?: FileSkillLoaderOptions["invoker"];
  #cache: SkillDescriptor[] | null = null;

  constructor(options: FileSkillLoaderOptions) {
    this.#root = options.workspaceRoot;
    if (options.invoker) this.#invoker = options.invoker;
  }

  async list(): Promise<SkillDescriptor[]> {
    if (this.#cache) return this.#cache;
    const skillsDir = join(this.#root, ".agents", "skills");
    const entries = await safeReaddir(skillsDir);
    const out: SkillDescriptor[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsDir, entry.name);
      const manifestPath = join(skillDir, "SKILL.md");
      const raw = await readFile(manifestPath, "utf-8").catch(() => null);
      if (!raw) continue;
      const descriptor = parseSkillManifest(raw, {
        fallbackName: entry.name,
        sourcePath: relative(this.#root, manifestPath),
      });
      if (descriptor) out.push(descriptor);
    }
    this.#cache = out;
    return out;
  }

  async get(name: string): Promise<SkillDescriptor | null> {
    const all = await this.list();
    return all.find((s) => s.name === name) ?? null;
  }

  async invoke(name: string, input: SkillInput): Promise<SkillOutput> {
    const descriptor = await this.get(name);
    if (!descriptor) {
      return {
        content: `Skill "${name}" not found in ${this.#root}`,
        isError: true,
      };
    }
    if (!this.#invoker) {
      return {
        content: `FileSkillLoader is parse-only — no invoker wired for "${name}"`,
        isError: true,
      };
    }
    return await this.#invoker(descriptor, input);
  }

  /** Clear the cached skill list. Next `list()` re-reads from disk. */
  reload(): void {
    this.#cache = null;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<Array<{ name: string; isDirectory: () => boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Parse YAML front-matter from a SKILL.md file. Only recognises a small
 * subset of YAML:
 *
 *   ---
 *   name: my-skill
 *   description: One-line description
 *   version: 0.1.0
 *   tier: T1
 *   tags: [foo, bar]
 *   input_schema:
 *     type: object
 *   ---
 *
 * For anything richer (nested objects beyond input_schema root), hosts
 * should ship their own parser. Returns `null` when required fields are
 * missing.
 */
export function parseSkillManifest(
  raw: string,
  fallbacks: { fallbackName: string; sourcePath?: string },
): SkillDescriptor | null {
  const fm = extractFrontMatter(raw);
  if (!fm) return null;

  const frontmatter: Record<string, unknown> = {};
  let inputSchemaLines: string[] = [];
  let collecting: string | null = null;

  for (const line of fm.split("\n")) {
    // Start of a key:value or key: block
    const topLevel = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (topLevel && !line.startsWith("  ")) {
      const key = topLevel[1] ?? "";
      const val = (topLevel[2] ?? "").trim();
      if (val === "") {
        // Block scalar follows
        collecting = key;
        if (key === "input_schema") inputSchemaLines = [];
      } else {
        collecting = null;
        frontmatter[key] = parseScalarOrList(val);
      }
    } else if (collecting === "input_schema") {
      inputSchemaLines.push(line);
    }
  }

  if (inputSchemaLines.length > 0) {
    frontmatter["input_schema"] = parseNestedBlock(inputSchemaLines);
  }

  const name = typeof frontmatter["name"] === "string"
    ? String(frontmatter["name"])
    : fallbacks.fallbackName;
  const description = typeof frontmatter["description"] === "string"
    ? String(frontmatter["description"])
    : "";
  const version = typeof frontmatter["version"] === "string"
    ? String(frontmatter["version"])
    : "0.0.0";
  const tierRaw = frontmatter["tier"];
  const tier: SkillDescriptor["tier"] =
    tierRaw === "T0" || tierRaw === "T2" || tierRaw === "T3" ? tierRaw : "T1";
  const inputSchema =
    typeof frontmatter["input_schema"] === "object" && frontmatter["input_schema"] !== null
      ? (frontmatter["input_schema"] as Record<string, unknown>)
      : {};
  const author = typeof frontmatter["author"] === "string" ? String(frontmatter["author"]) : undefined;
  const tags = Array.isArray(frontmatter["tags"])
    ? (frontmatter["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;

  const descriptor: SkillDescriptor = {
    name,
    description,
    version,
    tier,
    inputSchema,
  };
  if (fallbacks.sourcePath !== undefined) descriptor.sourcePath = fallbacks.sourcePath;
  if (author !== undefined) descriptor.author = author;
  if (tags !== undefined && tags.length > 0) descriptor.tags = tags;
  return descriptor;
}

function extractFrontMatter(raw: string): string | null {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(raw);
  return match ? (match[1] ?? null) : null;
}

function parseScalarOrList(val: string): unknown {
  if (val.startsWith("[") && val.endsWith("]")) {
    const inner = val.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => stripQuotes(s.trim()));
  }
  return stripQuotes(val);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse a naive nested YAML block for `input_schema`. Supports one level
 * of nesting:
 *
 *   input_schema:
 *     type: object
 *     required: [foo]
 *     properties:
 *       foo:
 *         type: string
 *
 * Nested `properties` is collected into a `{foo: {type: ...}}` shape by
 * counting indent. Good enough for most SKILL.md schemas; hosts with
 * complex schemas should use a real YAML parser.
 */
function parseNestedBlock(lines: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; container: Record<string, unknown> }[] = [
    { indent: -1, container: root },
  ];

  for (const rawLine of lines) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const kv = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? "";
    const val = (kv[2] ?? "").trim();

    // Pop stack frames with indent >= current.
    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? 0) >= indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (!top) continue;

    if (val === "") {
      // Nested block follows
      const nested: Record<string, unknown> = {};
      top.container[key] = nested;
      stack.push({ indent, container: nested });
    } else {
      top.container[key] = parseScalarOrList(val);
    }
  }
  return root;
}
