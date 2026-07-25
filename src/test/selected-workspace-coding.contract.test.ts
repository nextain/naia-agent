import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSelectedWorkspaceCoding } from "../main/adapters/selected-workspace-coding.js";

function git(path: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: path, encoding: "utf8" });
}

describe("UC-JEONJU selected workspace adapter", () => {
  it("allows only the ADK control root or a descendant Git root", () => {
    const parent = mkdtempSync(join(tmpdir(), "naia-jeonju-control-root-"));
    const controlRoot = join(parent, "naia-adk");
    const project = join(controlRoot, "projects", "course");
    const outside = join(parent, "other-project");
    try {
      for (const directory of [project, outside]) {
        mkdirSync(directory, { recursive: true });
        git(directory, ["init"]); git(directory, ["config", "user.email", "course@example.test"]); git(directory, ["config", "user.name", "Course"]);
        writeFileSync(join(directory, "index.html"), '<img src="./hero.svg">'); writeFileSync(join(directory, "hero.svg"), "<svg/>");
        git(directory, ["add", "index.html", "hero.svg"]); git(directory, ["commit", "-m", "initial"]); git(directory, ["remote", "add", "origin", "https://example.test/course.git"]);
      }
      const selected = makeSelectedWorkspaceCoding({ allowedWorkspaceRoot: controlRoot });
      expect(selected.prepare({ jobId: "nested", workspacePath: project, allowedFiles: ["index.html", "hero.svg"] }).worktreePath).toBe(project);
      expect(() => selected.prepare({ jobId: "outside", workspacePath: outside, allowedFiles: ["index.html", "hero.svg"] })).toThrow("outside the configured ADK root");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("leases a clean Git root, accepts only the two course files, and preserves an invalid result", () => {
    const repo = mkdtempSync(join(tmpdir(), "naia-jeonju-course-"));
    try {
      git(repo, ["init"]); git(repo, ["config", "user.email", "course@example.test"]); git(repo, ["config", "user.name", "Course"]);
      writeFileSync(join(repo, "index.html"), '<img src="./hero.svg">'); writeFileSync(join(repo, "hero.svg"), "<svg/>");
      git(repo, ["add", "index.html", "hero.svg"]); git(repo, ["commit", "-m", "initial"]); git(repo, ["remote", "add", "origin", "https://example.test/course.git"]);
      const selected = makeSelectedWorkspaceCoding();
      const allocation = selected.prepare({ jobId: "course-job", workspacePath: repo, allowedFiles: ["index.html", "hero.svg"] });
      const job = { jobId: "course-job", workspacePath: allocation.workspacePath, worktreePath: allocation.worktreePath, branch: allocation.branch, leaseId: allocation.leaseId, task: "course", executionMode: "selected_workspace" as const, allowedFiles: ["index.html", "hero.svg"], state: "running" as const, createdAt: "now", updatedAt: "now" };
      expect(selected.apply({ job, patch: { version: 1, files: [
        { path: "index.html", content: '<img src="./hero.svg"><h1>Naia</h1>' },
        { path: "hero.svg", content: "<svg><rect/></svg>" },
      ] } })).toMatchObject({ ok: true });
      expect(selected.verify({ job })).toMatchObject({ ok: true });
      writeFileSync(join(repo, "package.json"), "{}");
      expect(selected.verify({ job })).toMatchObject({ ok: false, summary: expect.stringContaining("unexpected_file") });
      expect(() => selected.prepare({ jobId: "bad", workspacePath: repo, allowedFiles: ["index.html", "index.html"] })).toThrow("exactly index.html and hero.svg");
      allocation.release();
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
