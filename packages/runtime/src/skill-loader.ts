/**
 * FileSkillLoader — reads naia-adk workspace format from disk.
 *
 * Implements `SkillLoader` from `@naia-adk/skill-spec` (adapter shape —
 * skill-spec interface is duplicated locally to avoid cross-repo runtime
 * dep, matching the skill-spec's own zero-dep stance).
 *
 * Workspace layout:
 *   .agents/skills/
 *     <skill-name>/
 *       SKILL.md          ← front-matter YAML + body
 *
 * This is a scaffold — full SKILL.md front-matter parsing is X4 scope.
 * Current impl returns empty lists; next commit wires in the parser.
 */

/** Local shape — mirrors `@naia-adk/skill-spec`'s `SkillLoader` interface
 *  without importing (skill-spec is a separate repo). When skill-spec is
 *  published to npm, this package can depend on it and drop the mirror. */
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
}

/**
 * FileSkillLoader — scans `<workspaceRoot>/.agents/skills/` for skill
 * directories each containing a `SKILL.md`. Returns descriptors parsed
 * from YAML front-matter (parser pending X4 implementation).
 *
 * **Scaffold**: returns empty list. Full parser wire-up is next commit.
 */
export class FileSkillLoader implements SkillLoader {
  readonly #root: string;

  constructor(options: FileSkillLoaderOptions) {
    this.#root = options.workspaceRoot;
  }

  async list(): Promise<SkillDescriptor[]> {
    // TODO (X4): scan this.#root/.agents/skills/*/SKILL.md, parse front-matter
    void this.#root;
    return [];
  }

  async get(name: string): Promise<SkillDescriptor | null> {
    // TODO (X4): find by name in the scanned list
    void name;
    return null;
  }

  async invoke(name: string, input: SkillInput): Promise<SkillOutput> {
    // TODO (X4): locate skill body, run via tool executor or dedicated
    // skill-runner; return the output.
    void name;
    void input;
    return {
      content: `FileSkillLoader is a scaffold; skill "${name}" invocation is not yet wired`,
      isError: true,
    };
  }
}
