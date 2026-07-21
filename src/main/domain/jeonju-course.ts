/** Deterministic policy for the narrowly-scoped Jeonju workshop write mode. */
export const JEONJU_ALLOWED_FILES = ["index.html", "hero.svg"] as const;
export type JeonjuAllowedFile = (typeof JEONJU_ALLOWED_FILES)[number];

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
  if (!after.changedFiles.includes("index.html") || !after.changedFiles.includes("hero.svg")) return { ok: false, reason: "missing_required_file" };
  return contents["index.html"]?.includes("./hero.svg") ? { ok: true } : { ok: false, reason: "invalid_hero_reference" };
}
