import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import type { CodingJobAllocation, CodingJobWorktreePort } from "../ports/coding-job.js";

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,120}$/.test(value)) throw new Error("invalid coding job id");
  return value;
}

export function makeGitCodingJobWorktrees(input: {
  readonly allowedWorkspaceRoot: string;
  readonly worktreeRoot: string;
  readonly git?: (args: readonly string[], cwd: string) => void;
}): CodingJobWorktreePort {
  const allowedRoot = realpathSync(input.allowedWorkspaceRoot);
  const managedRoot = resolve(input.worktreeRoot);
  const git = input.git ?? ((args, cwd) => { execFileSync("git", [...args], { cwd, stdio: "ignore" }); });
  return {
    allocate({ jobId, workspacePath }): CodingJobAllocation {
      const safeId = safeSegment(jobId);
      const source = realpathSync(workspacePath);
      if (!contained(allowedRoot, source)) throw new Error("workspace is outside configured root");
      git(["rev-parse", "--is-inside-work-tree"], source);
      mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
      const worktreePath = resolve(managedRoot, `${basename(source)}-${safeId}`);
      if (!contained(managedRoot, worktreePath) || existsSync(worktreePath)) throw new Error("managed worktree path is unavailable");
      const branch = `naia/coding-job/${safeId}`;
      const leaseId = randomUUID();
      const leasePath = join(managedRoot, `.lease-${safeId}.json`);
      if (existsSync(leasePath)) throw new Error("coding job lease is unavailable");
      let descriptor: number | undefined;
      try {
        descriptor = openSync(leasePath, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify({ jobId: safeId, leaseId, workspacePath: source }));
        closeSync(descriptor); descriptor = undefined;
        git(["worktree", "add", "--no-track", "-b", branch, worktreePath, "HEAD"], source);
      } catch (error) {
        if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
        try { rmSync(leasePath, { force: true }); } catch { /* best effort */ }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("coding job lease is unavailable");
        throw error;
      }
      return {
        workspacePath: source,
        worktreePath,
        branch,
        leaseId,
        release() {
          // Keep the completed worktree for inspection/diff. Cleanup is an explicit
          // product action; terminal completion only releases the exclusive lease.
          try { rmSync(leasePath, { force: true }); } catch { /* best effort */ }
        },
      };
    },
  };
}
