import { describe, expect, it } from "vitest";
import { checkJeonjuWorkspaceFinish, checkJeonjuWorkspaceStart, type JeonjuWorkspaceSnapshot } from "../main/domain/jeonju-course.js";

const clean: JeonjuWorkspaceSnapshot = { gitRoot: "D:/course/repo", head: "abc", remote: "origin https://example/repo", changedFiles: [] };

describe("UC-JEONJU selected-workspace policy", () => {
  it("requires the explicitly selected Git root and a clean student repository before Codex starts", () => {
    expect(checkJeonjuWorkspaceStart("D:/course/repo", clean)).toEqual({ ok: true });
    expect(checkJeonjuWorkspaceStart("D:/course/other", clean)).toMatchObject({ ok: false, reason: "git_root_mismatch" });
    expect(checkJeonjuWorkspaceStart("D:/course/repo", { ...clean, changedFiles: ["README.md"] })).toMatchObject({ ok: false, reason: "dirty_workspace" });
  });

  it("accepts one or both approved course files and rejects history, remote, and extra-file changes", () => {
    const after = { ...clean, changedFiles: ["index.html", "hero.svg"] };
    expect(checkJeonjuWorkspaceFinish(clean, after, { "index.html": '<img src="./hero.svg">', "hero.svg": "<svg/>" })).toEqual({ ok: true });
    expect(checkJeonjuWorkspaceFinish(clean, { ...clean, changedFiles: ["index.html"] }, { "index.html": '<img src="./hero.svg"><section>revised</section>', "hero.svg": "<svg/>" })).toEqual({ ok: true });
    expect(checkJeonjuWorkspaceFinish(clean, { ...after, changedFiles: [...after.changedFiles, "package.json"] }, { "index.html": '<img src="./hero.svg">', "hero.svg": "<svg/>" })).toMatchObject({ ok: false, reason: "unexpected_file" });
    expect(checkJeonjuWorkspaceFinish(clean, { ...after, head: "changed" }, { "index.html": '<img src="./hero.svg">', "hero.svg": "<svg/>" })).toMatchObject({ ok: false, reason: "history_changed" });
    expect(checkJeonjuWorkspaceFinish(clean, { ...after, remote: "changed" }, { "index.html": '<img src="./hero.svg">', "hero.svg": "<svg/>" })).toMatchObject({ ok: false, reason: "remote_changed" });
  });
});
