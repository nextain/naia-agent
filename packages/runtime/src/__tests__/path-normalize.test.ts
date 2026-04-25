// Slice 1b sub-6 — D09 Workspace sentinel tests.
// OWASP A01 Path Traversal coverage. Cleanroom 라인 직접 인용 0 (F09 준수).

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join, sep } from "node:path";
import { normalizeWorkspacePath, WorkspaceEscapeError } from "../utils/path-normalize.js";

const root = mkdtempSync(join(tmpdir(), "naia-pathnorm-"));

describe("normalizeWorkspacePath (D09)", () => {
  it("resolves a simple relative path inside workspace", () => {
    const out = normalizeWorkspacePath("foo/bar.txt", root);
    expect(out).toBe(join(root, "foo", "bar.txt"));
  });

  it("normalizes ./ and bare names", () => {
    expect(normalizeWorkspacePath("./a", root)).toBe(join(root, "a"));
    expect(normalizeWorkspacePath("a/./b", root)).toBe(join(root, "a", "b"));
  });

  it("collapses redundant ../ within bounds", () => {
    const out = normalizeWorkspacePath("a/b/../c", root);
    expect(out).toBe(join(root, "a", "c"));
  });

  it("rejects ../ that escapes workspace root", () => {
    expect(() => normalizeWorkspacePath("../escape.txt", root)).toThrow(
      WorkspaceEscapeError,
    );
    expect(() => normalizeWorkspacePath("../../etc/passwd", root)).toThrow(
      WorkspaceEscapeError,
    );
    expect(() => normalizeWorkspacePath("a/../../escape", root)).toThrow(
      WorkspaceEscapeError,
    );
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => normalizeWorkspacePath("/etc/passwd", root)).toThrow(
      WorkspaceEscapeError,
    );
    expect(() => normalizeWorkspacePath("/tmp/something-else", root)).toThrow(
      WorkspaceEscapeError,
    );
  });

  it("accepts absolute path that is inside workspace (idempotent)", () => {
    const inside = join(root, "subdir", "file.txt");
    const out = normalizeWorkspacePath(inside, root);
    expect(out).toBe(inside);
  });

  it("rejects partial-prefix attacks (sentinel check)", () => {
    // If sentinel is `startsWith(root)` without separator, a malicious sibling
    // root might pass. We use `startsWith(root + sep)` to prevent this.
    const sibling = root + "malicious";
    expect(() => normalizeWorkspacePath(sibling, root)).toThrow(
      WorkspaceEscapeError,
    );
  });

  it("treats root itself as valid (no escape)", () => {
    expect(normalizeWorkspacePath("", root)).toBe(root);
    expect(normalizeWorkspacePath(".", root)).toBe(root);
  });

  it("throws when workspaceRoot is empty", () => {
    expect(() => normalizeWorkspacePath("x", "")).toThrow(/workspaceRoot is empty/);
  });

  it("WorkspaceEscapeError carries diagnostic data", () => {
    try {
      normalizeWorkspacePath("../leak", root);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceEscapeError);
      expect((e as WorkspaceEscapeError).attempted).toBe("../leak");
      expect((e as WorkspaceEscapeError).workspaceRoot).toContain(sep);
    }
  });
});
