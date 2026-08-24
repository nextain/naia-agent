import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrateLegacyKnowledge,
  migrateLegacyMemoryStore,
  migrateLegacyMemoryStoreFile,
  migrateLegacyWorkspaceIdentity,
  resolveProductKnowledgeDir,
  resolveProductStorage,
  storeDirKey,
} from "../main/adapters/workspace-project.js";

describe("naia-agent product storage boundary", () => {
  it("fixes memory and knowledge paths below naia-settings", () => {
    const root = resolve("/ws/adk");
    expect(resolveProductStorage(root)).toEqual({
      settingsDir: join(root, "naia-settings"),
      memoryDir: join(root, "naia-settings", "memory"),
      memoryStorePath: join(root, "naia-settings", "memory", "store.json"),
      workspaceIdPath: join(root, "naia-settings", "memory", "workspace-id"),
    });
    expect(resolveProductKnowledgeDir("/ws/adk", "personal-ko")).toBe(
      "/ws/adk/naia-settings/knowledge/personal-ko",
    );
    expect(resolveProductKnowledgeDir("/ws/adk", "고객1")).toBe(
      join(resolve("/ws/adk"), "naia-settings", "knowledge", "고객1"),
    );
  });

  it("keeps valid multilingual scopes as one safe segment", () => {
    expect(resolveProductKnowledgeDir("/ws/adk", "고객1")).toBe(
      join(resolve("/ws/adk"), "naia-settings", "knowledge", "고객1"),
    );
  });

  it("rejects knowledge scopes that could escape or hide inside the boundary", () => {
    for (const scope of ["../outside", "..", "a/b", "a\\b", "", ".hidden"]) {
      expect(() => resolveProductKnowledgeDir("/ws/adk", scope)).toThrow();
    }
  });

  it("copies legacy identity, memory and knowledge once while preserving destination authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "naia-product-migration-"));
    const legacyMemory = join(root, "legacy-home-memory");
    const project = "ws-12345678-1234-1234-1234-123456789abc";
    const deps = {
      exists: existsSync,
      mkdir: (path: string) => mkdirSync(path, { recursive: true }),
      validateSource: (source: string, expectedRoot: string) => {
        const realRoot = realpathSync(expectedRoot);
        const realSource = realpathSync(source);
        if (realSource !== realRoot && !realSource.startsWith(`${realRoot}/`)) throw new Error("legacy source escapes");
      },
      copyExclusive: (source: string, destination: string) => copyFileSync(source, destination, constants.COPYFILE_EXCL),
    };
    try {
      mkdirSync(join(root, ".naia"), { recursive: true });
      mkdirSync(join(legacyMemory, storeDirKey(project)), { recursive: true });
      mkdirSync(join(root, "knowledge", "고객1"), { recursive: true });
      writeFileSync(join(root, ".naia", "workspace-id"), "12345678-1234-1234-1234-123456789abc");
      writeFileSync(join(legacyMemory, storeDirKey(project), "store.json"), "legacy-store");
      writeFileSync(join(root, "knowledge", "고객1", "kb.json"), "legacy-kb");

      expect(migrateLegacyWorkspaceIdentity(root, deps)).toBe(true);
      expect(migrateLegacyMemoryStore(root, project, legacyMemory, deps)).toBe(true);
      expect(migrateLegacyKnowledge(root, "고객1", deps)).toBe(true);
      expect(readFileSync(resolveProductStorage(root).workspaceIdPath, "utf8")).toBe("12345678-1234-1234-1234-123456789abc");
      expect(readFileSync(resolveProductStorage(root).memoryStorePath, "utf8")).toBe("legacy-store");
      expect(readFileSync(join(resolveProductKnowledgeDir(root, "고객1"), "kb.json"), "utf8")).toBe("legacy-kb");

      writeFileSync(resolveProductStorage(root).memoryStorePath, "new-store");
      expect(migrateLegacyMemoryStore(root, project, legacyMemory, deps)).toBe(false);
      expect(readFileSync(resolveProductStorage(root).memoryStorePath, "utf8")).toBe("new-store");

      expect(migrateLegacyMemoryStoreFile(root, join(legacyMemory, storeDirKey(project), "store.json"), deps)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects a legacy knowledge scope that escapes through an intermediate symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "naia-product-migration-link-"));
    const outside = await mkdtemp(join(tmpdir(), "naia-product-migration-outside-"));
    const deps = {
      exists: existsSync,
      mkdir: (path: string) => mkdirSync(path, { recursive: true }),
      validateSource: (source: string, expectedRoot: string) => {
        const realRoot = realpathSync(expectedRoot);
        const realSource = realpathSync(source);
        if (realSource !== realRoot && !realSource.startsWith(`${realRoot}/`)) throw new Error("legacy source escapes");
      },
      copyExclusive: (source: string, destination: string) => copyFileSync(source, destination, constants.COPYFILE_EXCL),
    };
    try {
      mkdirSync(join(root, "knowledge"), { recursive: true });
      mkdirSync(join(outside, "default"), { recursive: true });
      writeFileSync(join(outside, "default", "kb.json"), "outside-kb");
      symlinkSync(join(outside, "default"), join(root, "knowledge", "default"), "dir");
      expect(() => migrateLegacyKnowledge(root, "default", deps)).toThrow("legacy source escapes");
      expect(existsSync(join(root, "naia-settings", "knowledge", "default", "kb.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
