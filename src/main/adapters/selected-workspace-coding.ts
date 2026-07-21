import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEONJU_ALLOWED_FILES,
  checkJeonjuWorkspaceFinish,
  checkJeonjuWorkspaceStart,
  type JeonjuWorkspaceSnapshot,
} from "../domain/jeonju-course.js";
import type { CodingJobAllocation, SelectedWorkspaceCodingPort } from "../ports/coding-job.js";

type Git = (args: readonly string[], cwd: string) => string;

interface Lease {
  readonly workspacePath: string;
  readonly leaseId: string;
  readonly before: JeonjuWorkspaceSnapshot;
}

function sameFiles(files: readonly string[]): boolean {
  return files.length === JEONJU_ALLOWED_FILES.length
    && new Set(files).size === JEONJU_ALLOWED_FILES.length
    && files.every((file) => JEONJU_ALLOWED_FILES.includes(file as (typeof JEONJU_ALLOWED_FILES)[number]));
}

function snapshot(workspacePath: string, git: Git): JeonjuWorkspaceSnapshot {
  const gitRoot = realpathSync(git(["rev-parse", "--show-toplevel"], workspacePath).trim());
  const changedFiles = git(["status", "--porcelain", "--untracked-files=all"], workspacePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3));
  const remote = git(["config", "--get", "remote.origin.url"], workspacePath).trim();
  return {
    gitRoot,
    changedFiles,
    head: git(["rev-parse", "HEAD"], workspacePath).trim(),
    remote,
  };
}

/**
 * Direct student-repository execution is deliberately separate from normal
 * coding-job worktrees. It leases one clean Git root, and never resets it:
 * rejected changes are preserved for the student to inspect and clean up.
 */
export function makeSelectedWorkspaceCoding(input: { readonly git?: Git } = {}): SelectedWorkspaceCodingPort {
  const git = input.git ?? ((args, cwd) => execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const leases = new Map<string, Lease>();
  const activeWorkspace = new Map<string, string>();

  return {
    prepare({ jobId, workspacePath, allowedFiles }): CodingJobAllocation {
      if (!sameFiles(allowedFiles)) throw new Error("selected workspace allows exactly index.html and hero.svg");
      const source = realpathSync(workspacePath);
      const before = snapshot(source, git);
      const start = checkJeonjuWorkspaceStart(source, before);
      if (!start.ok) throw new Error(start.reason);
      if (!before.remote) throw new Error("selected workspace must have a Git remote");
      if (activeWorkspace.has(source)) throw new Error("selected workspace already has an active coding job");

      const leaseId = randomUUID();
      leases.set(jobId, { workspacePath: source, leaseId, before });
      activeWorkspace.set(source, jobId);
      return {
        workspacePath: source,
        worktreePath: source,
        branch: "selected-workspace",
        leaseId,
        release() {
          const lease = leases.get(jobId);
          leases.delete(jobId);
          if (lease && activeWorkspace.get(lease.workspacePath) === jobId) activeWorkspace.delete(lease.workspacePath);
        },
      };
    },

    verify({ job }) {
      const lease = leases.get(job.jobId);
      if (!lease || lease.workspacePath !== job.workspacePath || lease.leaseId !== job.leaseId) {
        return { ok: false, summary: "selected workspace lease is unavailable; changes were preserved for manual review" };
      }
      try {
        const after = snapshot(lease.workspacePath, git);
        const contents = {
          "index.html": readFileSync(resolve(lease.workspacePath, "index.html"), "utf8"),
          "hero.svg": readFileSync(resolve(lease.workspacePath, "hero.svg"), "utf8"),
        };
        const result = checkJeonjuWorkspaceFinish(lease.before, after, contents);
        return result.ok
          ? { ok: true, summary: "selected workspace verified: only index.html and hero.svg changed; Git history and remote are unchanged" }
          : { ok: false, summary: `${result.reason}; changes were preserved for manual review` };
      } catch (error) {
        return {
          ok: false,
          summary: `selected workspace verification failed; changes were preserved for manual review: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
