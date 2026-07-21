import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSelectedWorkspaceCoding } from "../main/adapters/selected-workspace-coding.js";

function git(path: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: path, encoding: "utf8" });
}

describe("UC-JEONJU selected workspace adapter", () => {
  it("leases a clean Git root, accepts only the two course files, and preserves an invalid result", () => {
    const repo = mkdtempSync(join(tmpdir(), "naia-jeonju-course-"));
    try {
      git(repo, ["init"]); git(repo, ["config", "user.email", "course@example.test"]); git(repo, ["config", "user.name", "Course"]);
      writeFileSync(join(repo, "index.html"), '<img src="./hero.svg">'); writeFileSync(join(repo, "hero.svg"), "<svg/>");
      git(repo, ["add", "index.html", "hero.svg"]); git(repo, ["commit", "-m", "initial"]); git(repo, ["remote", "add", "origin", "https://example.test/course.git"]);
      const selected = makeSelectedWorkspaceCoding();
      const allocation = selected.prepare({ jobId: "course-job", workspacePath: repo, allowedFiles: ["index.html", "hero.svg"] });
      writeFileSync(join(repo, "index.html"), '<img src="./hero.svg"><h1>Naia</h1>'); writeFileSync(join(repo, "hero.svg"), "<svg><rect/></svg>");
      expect(selected.verify({ job: { jobId: "course-job", workspacePath: allocation.workspacePath, worktreePath: allocation.worktreePath, branch: allocation.branch, leaseId: allocation.leaseId, task: "course", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], state: "running", createdAt: "now", updatedAt: "now" } })).toMatchObject({ ok: true });
      writeFileSync(join(repo, "package.json"), "{}");
      expect(selected.verify({ job: { jobId: "course-job", workspacePath: allocation.workspacePath, worktreePath: allocation.worktreePath, branch: allocation.branch, leaseId: allocation.leaseId, task: "course", executionMode: "selected_workspace", allowedFiles: ["index.html", "hero.svg"], state: "running", createdAt: "now", updatedAt: "now" } })).toMatchObject({ ok: false, summary: expect.stringContaining("unexpected_file") });
      expect(() => selected.prepare({ jobId: "bad", workspacePath: repo, allowedFiles: ["index.html", "index.html"] })).toThrow("exactly index.html and hero.svg");
      allocation.release();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
