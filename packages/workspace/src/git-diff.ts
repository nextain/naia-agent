import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Lazy unified diff for path. Returns null if not in git repo, path is
 * untracked + unchanged, or git fails. Handles stash/rebase states by
 * reading the working tree against HEAD (default git diff semantics).
 */
export async function gitDiff(
  workdir: string,
  filePath: string,
): Promise<string | null> {
  if (!(await isGitRepo(workdir))) return null;
  try {
    const { stdout } = await execFileP(
      "git",
      ["diff", "--no-color", "--", filePath],
      { cwd: workdir, maxBuffer: 16 * 1024 * 1024 },
    );
    if (stdout.length > 0) return stdout;
    // git diff returned empty — distinguish (a) tracked + unchanged (return null)
    // from (b) untracked file (compare vs /dev/null).
    const tracked = await isTrackedPath(workdir, filePath);
    if (tracked) return null;
    try {
      const { stdout: untracked } = await execFileP(
        "git",
        ["diff", "--no-index", "--no-color", "/dev/null", filePath],
        { cwd: workdir, maxBuffer: 16 * 1024 * 1024 },
      );
      return untracked.length > 0 ? untracked : null;
    } catch (e) {
      // git diff --no-index returns 1 when files differ — promisify rejects
      const err = e as { stdout?: string; code?: number };
      if (err.stdout && err.stdout.length > 0) return err.stdout;
      return null;
    }
  } catch {
    return null;
  }
}

async function isTrackedPath(workdir: string, filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "--error-unmatch", "--", filePath],
      { cwd: workdir },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Aggregate additions/deletions for path or whole workdir using git diff
 * --numstat. Returns {0,0} when no changes or non-git repo.
 */
export async function gitDiffStats(
  workdir: string,
  filePath?: string,
): Promise<{ additions: number; deletions: number }> {
  if (!(await isGitRepo(workdir))) return { additions: 0, deletions: 0 };
  const args = ["diff", "--numstat", "--no-color"];
  if (filePath !== undefined) args.push("--", filePath);
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: workdir,
      maxBuffer: 16 * 1024 * 1024,
    });
    let additions = 0;
    let deletions = 0;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const cols = trimmed.split(/\s+/);
      // numstat: <add>\t<del>\t<path> — binary files show "-\t-\t<path>"
      const a = cols[0];
      const d = cols[1];
      if (a && a !== "-") additions += parseInt(a, 10) || 0;
      if (d && d !== "-") deletions += parseInt(d, 10) || 0;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

async function isGitRepo(workdir: string): Promise<boolean> {
  try {
    await execFileP("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workdir,
    });
    return true;
  } catch {
    return false;
  }
}
