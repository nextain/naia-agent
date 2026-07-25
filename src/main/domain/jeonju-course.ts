/** Deterministic policy for the narrowly-scoped Jeonju workshop write mode. */
export const JEONJU_ALLOWED_FILES = ["index.html", "hero.svg"] as const;
export type JeonjuAllowedFile = (typeof JEONJU_ALLOWED_FILES)[number];

/** A provider-neutral, fully-materialized course change proposal. */
export interface JeonjuCoursePatch {
  readonly version: 1;
  readonly files: readonly { readonly path: JeonjuAllowedFile; readonly content: string }[];
}

export type JeonjuCoursePatchParse =
  | { readonly ok: true; readonly patch: JeonjuCoursePatch }
  | { readonly ok: false; readonly reason: "invalid_json" | "invalid_shape" | "invalid_file" | "duplicate_file" | "empty_patch" | "oversized_patch" };

const MAX_PATCH_FILE_BYTES = 256 * 1024;
const MAX_PATCH_TOTAL_BYTES = 512 * 1024;

/**
 * Parses only the small exact JSON contract shared by all proposal providers.
 * It intentionally returns a redacted reason rather than model output.
 */
export function parseJeonjuCoursePatch(text: string): JeonjuCoursePatchParse {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: "invalid_json" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid_shape" };
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.files) || Object.keys(record).length !== 2
    || !Object.prototype.hasOwnProperty.call(record, "version") || !Object.prototype.hasOwnProperty.call(record, "files")) {
    return { ok: false, reason: "invalid_shape" };
  }
  if (record.files.length === 0) return { ok: false, reason: "empty_patch" };
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: { path: JeonjuAllowedFile; content: string }[] = [];
  for (const item of record.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, reason: "invalid_shape" };
    const file = item as Record<string, unknown>;
    if (Object.keys(file).length !== 2 || typeof file.path !== "string" || typeof file.content !== "string") {
      return { ok: false, reason: "invalid_shape" };
    }
    if (!JEONJU_ALLOWED_FILES.includes(file.path as JeonjuAllowedFile)) return { ok: false, reason: "invalid_file" };
    if (seen.has(file.path)) return { ok: false, reason: "duplicate_file" };
    const bytes = new TextEncoder().encode(file.content).byteLength;
    totalBytes += bytes;
    if (bytes > MAX_PATCH_FILE_BYTES || totalBytes > MAX_PATCH_TOTAL_BYTES) return { ok: false, reason: "oversized_patch" };
    seen.add(file.path);
    files.push({ path: file.path as JeonjuAllowedFile, content: file.content });
  }
  return { ok: true, patch: { version: 1, files } };
}

export interface JeonjuWorkspaceSnapshot {
  readonly gitRoot: string;
  readonly head: string;
  readonly remote: string;
  readonly changedFiles: readonly string[];
}

export type JeonjuWorkspaceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "git_root_mismatch" | "dirty_workspace" | "history_changed" | "remote_changed" | "unexpected_file" | "missing_required_file" | "invalid_hero_reference" };

export function checkJeonjuWorkspaceStart(selectedPath: string, snapshot: JeonjuWorkspaceSnapshot): JeonjuWorkspaceCheck {
  if (!selectedPath || snapshot.gitRoot !== selectedPath) return { ok: false, reason: "git_root_mismatch" };
  return snapshot.changedFiles.length === 0 ? { ok: true } : { ok: false, reason: "dirty_workspace" };
}

export function checkJeonjuWorkspaceFinish(
  before: JeonjuWorkspaceSnapshot,
  after: JeonjuWorkspaceSnapshot,
  contents: Readonly<Record<JeonjuAllowedFile, string | undefined>>,
): JeonjuWorkspaceCheck {
  if (before.gitRoot !== after.gitRoot) return { ok: false, reason: "git_root_mismatch" };
  if (before.head !== after.head) return { ok: false, reason: "history_changed" };
  if (before.remote !== after.remote) return { ok: false, reason: "remote_changed" };
  if (after.changedFiles.some((file) => !JEONJU_ALLOWED_FILES.includes(file as JeonjuAllowedFile))) return { ok: false, reason: "unexpected_file" };
  // The first build normally changes both files, while a later lesson revision
  // may legitimately change only index.html.  The fixed file set is an upper
  // boundary, not a requirement to churn both files on every request.
  if (after.changedFiles.length === 0 || !contents["index.html"] || !contents["hero.svg"]) return { ok: false, reason: "missing_required_file" };
  return contents["index.html"].includes("./hero.svg") ? { ok: true } : { ok: false, reason: "invalid_hero_reference" };
}
