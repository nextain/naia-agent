import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitDiff, gitDiffStats } from "../git-diff.js";

let workdir = "";

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: workdir, stdio: "ignore" });
}

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "naia-gd-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(path.join(workdir, "a.txt"), "v1\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("gitDiff / gitDiffStats — happy path + edge cases", () => {
  it("returns null when path is unchanged", async () => {
    const diff = await gitDiff(workdir, "a.txt");
    expect(diff).toBeNull();
  });

  it("returns diff string when path is modified", async () => {
    writeFileSync(path.join(workdir, "a.txt"), "v2\n");
    const diff = await gitDiff(workdir, "a.txt");
    expect(diff).not.toBeNull();
    expect(diff).toContain("v1");
    expect(diff).toContain("v2");
  });

  it("returns diff for newly created (untracked) file", async () => {
    writeFileSync(path.join(workdir, "new.txt"), "fresh\n");
    const diff = await gitDiff(workdir, "new.txt");
    expect(diff).not.toBeNull();
    expect(diff).toContain("fresh");
  });

  it("gitDiffStats returns 0/0 when no changes", async () => {
    const s = await gitDiffStats(workdir);
    expect(s.additions).toBe(0);
    expect(s.deletions).toBe(0);
  });

  it("gitDiffStats counts additions/deletions", async () => {
    writeFileSync(path.join(workdir, "a.txt"), "line1\nline2\nline3\n");
    const s = await gitDiffStats(workdir, "a.txt");
    expect(s.additions).toBeGreaterThan(0);
    expect(s.deletions).toBeGreaterThan(0);
  });

  it("returns {0,0} stats for non-git workdir", async () => {
    const nonGit = mkdtempSync(path.join(tmpdir(), "naia-no-git-"));
    try {
      const s = await gitDiffStats(nonGit);
      expect(s.additions).toBe(0);
      expect(s.deletions).toBe(0);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns null diff for non-git workdir", async () => {
    const nonGit = mkdtempSync(path.join(tmpdir(), "naia-no-git2-"));
    try {
      writeFileSync(path.join(nonGit, "x.txt"), "hi");
      const diff = await gitDiff(nonGit, "x.txt");
      expect(diff).toBeNull();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("survives mid-rebase state (returns numstat without crashing)", async () => {
    writeFileSync(path.join(workdir, "a.txt"), "v2\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "v2");
    writeFileSync(path.join(workdir, "a.txt"), "v3\n");
    const s = await gitDiffStats(workdir);
    expect(s).toEqual(expect.objectContaining({ additions: expect.any(Number) }));
  });
});
