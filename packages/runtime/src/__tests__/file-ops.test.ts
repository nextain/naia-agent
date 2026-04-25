// Slice 2.6 — file-ops skills unit tests.
// Coverage: read/write/edit/list + workspace boundary (D09) + size limits.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReadFileSkill,
  createWriteFileSkill,
  createEditFileSkill,
  createListFilesSkill,
  createFileOpsSkills,
} from "../skills/file-ops.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "naia-fileops-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createReadFileSkill", () => {
  it("reads a UTF-8 text file", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const skill = createReadFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "a.txt" });
    expect(out).toBe("hello");
  });

  it("returns ERROR for missing file", async () => {
    const skill = createReadFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "nope.txt" });
    expect(out as string).toMatch(/^ERROR:/);
  });

  it("BLOCKS path traversal escaping workspace", async () => {
    const skill = createReadFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "../../etc/passwd" });
    expect(out as string).toMatch(/^BLOCKED:/);
  });

  it("truncates large files at maxBytes boundary", async () => {
    const big = "x".repeat(2048);
    writeFileSync(join(root, "big.txt"), big);
    const skill = createReadFileSkill({ workspaceRoot: root, maxBytes: 100 });
    const out = await skill.handler({ path: "big.txt" });
    expect((out as string).length).toBeLessThan(big.length);
    expect(out as string).toContain("[truncated");
  });

  it("ERROR on missing path arg", async () => {
    const skill = createReadFileSkill({ workspaceRoot: root });
    const out = await skill.handler({} as Record<string, unknown>);
    expect(out as string).toMatch(/^ERROR/);
  });

  it("read_file is T0 + concurrencySafe", () => {
    const skill = createReadFileSkill({ workspaceRoot: root });
    expect(skill.tier).toBe("T0");
    expect(skill.isConcurrencySafe).toBe(true);
  });
});

describe("createWriteFileSkill", () => {
  it("writes a new file and reports byte count", async () => {
    const skill = createWriteFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "new.txt", content: "hello" });
    expect(out as string).toContain("wrote 5 bytes");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hello");
  });

  it("creates parent directories", async () => {
    const skill = createWriteFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "deep/nested/file.txt", content: "x" });
    expect(out as string).toContain("wrote");
    expect(existsSync(join(root, "deep/nested/file.txt"))).toBe(true);
  });

  it("overwrites existing file", async () => {
    writeFileSync(join(root, "x.txt"), "old");
    const skill = createWriteFileSkill({ workspaceRoot: root });
    await skill.handler({ path: "x.txt", content: "new" });
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("new");
  });

  it("BLOCKS write outside workspace", async () => {
    const skill = createWriteFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "../escape.txt", content: "x" });
    expect(out as string).toMatch(/^BLOCKED:/);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("REJECTS content exceeding maxBytes", async () => {
    const skill = createWriteFileSkill({ workspaceRoot: root, maxBytes: 10 });
    const out = await skill.handler({ path: "big.txt", content: "x".repeat(100) });
    expect(out as string).toMatch(/exceeds maxBytes/);
  });

  it("write_file is T1 + destructive + non-concurrent", () => {
    const skill = createWriteFileSkill({ workspaceRoot: root });
    expect(skill.tier).toBe("T1");
    expect(skill.isDestructive).toBe(true);
    expect(skill.isConcurrencySafe).toBe(false);
  });
});

describe("createEditFileSkill", () => {
  it("replaces single occurrence by default", async () => {
    writeFileSync(join(root, "f.txt"), "abc abc abc");
    const skill = createEditFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "f.txt", find: "abc", replace: "X" });
    expect(out as string).toContain("1 replacement");
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("X abc abc");
  });

  it("replaceAll=true replaces all", async () => {
    writeFileSync(join(root, "f.txt"), "abc abc abc");
    const skill = createEditFileSkill({ workspaceRoot: root });
    const out = await skill.handler({
      path: "f.txt",
      find: "abc",
      replace: "X",
      replaceAll: true,
    });
    expect(out as string).toContain("3 replacement");
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("X X X");
  });

  it("ERROR if find pattern not found", async () => {
    writeFileSync(join(root, "f.txt"), "abc");
    const skill = createEditFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "f.txt", find: "xyz", replace: "Y" });
    expect(out as string).toMatch(/^ERROR: find pattern not found/);
  });

  it("BLOCKS path traversal", async () => {
    const skill = createEditFileSkill({ workspaceRoot: root });
    const out = await skill.handler({
      path: "../../etc/hosts",
      find: "x",
      replace: "y",
    });
    expect(out as string).toMatch(/^BLOCKED:/);
  });

  it("ERROR on empty find string", async () => {
    writeFileSync(join(root, "f.txt"), "x");
    const skill = createEditFileSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "f.txt", find: "", replace: "Y" });
    expect(out as string).toMatch(/^ERROR/);
  });
});

describe("createListFilesSkill", () => {
  it("lists entries with type prefix", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    mkdirSync(join(root, "sub"));
    const skill = createListFilesSkill({ workspaceRoot: root });
    const out = (await skill.handler({})) as string;
    expect(out).toMatch(/\[f\] a\.txt/);
    expect(out).toMatch(/\[d\] sub/);
  });

  it("lists subdirectory contents with workspace-relative path", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.txt"), "x");
    const skill = createListFilesSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "sub" });
    expect(out as string).toContain("[f] b.txt");
  });

  it("BLOCKS path traversal", async () => {
    const skill = createListFilesSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "../../" });
    expect(out as string).toMatch(/^BLOCKED:/);
  });

  it("returns (empty directory) for empty dirs", async () => {
    const skill = createListFilesSkill({ workspaceRoot: root });
    const out = await skill.handler({ path: "." });
    expect(out as string).toBe("(empty directory)");
  });
});

describe("createFileOpsSkills (bundle)", () => {
  it("returns 4 skills (read/write/edit/list)", () => {
    const skills = createFileOpsSkills({ workspaceRoot: root });
    expect(skills.map((s) => s.name).sort()).toEqual([
      "edit_file",
      "list_files",
      "read_file",
      "write_file",
    ]);
  });

  it("end-to-end: write → read → edit → list", async () => {
    const [readS, writeS, editS, listS] = createFileOpsSkills({ workspaceRoot: root }) as [
      ReturnType<typeof createReadFileSkill>,
      ReturnType<typeof createWriteFileSkill>,
      ReturnType<typeof createEditFileSkill>,
      ReturnType<typeof createListFilesSkill>,
    ];
    await writeS.handler({ path: "out.txt", content: "hello world" });
    expect(await readS.handler({ path: "out.txt" })).toBe("hello world");
    await editS.handler({ path: "out.txt", find: "world", replace: "naia" });
    expect(await readS.handler({ path: "out.txt" })).toBe("hello naia");
    expect(await listS.handler({ path: "." })).toContain("[f] out.txt");
  });
});
