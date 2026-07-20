import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceOwnerOnlyAtomic,
  type OwnerOnlyAtomicFileSystem,
} from "../main/adapters/owner-only-atomic-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "naia-owner-atomic-"));
  dirs.push(directory);
  return directory;
}

function recordingFs(input?: {
  readonly ids?: readonly string[];
  readonly failAt?: "open" | "write" | "sync" | "replace";
  readonly failDirectorySync?: boolean;
}): OwnerOnlyAtomicFileSystem & {
  readonly calls: string[];
  readonly replacements: string[];
} {
  const calls: string[] = [];
  const replacements: string[] = [];
  const ids = [...(input?.ids ?? ["unique"])];
  return {
    calls,
    replacements,
    mkdir(path) { calls.push(`mkdir:${path}`); },
    openExclusive(path) {
      calls.push(`open:${path}`);
      if (input?.failAt === "open") throw new Error("open failed");
      return 17;
    },
    write(_descriptor, contents) {
      calls.push(`write:${contents}`);
      if (input?.failAt === "write") throw new Error("write failed");
    },
    restrictToOwner(descriptor) { calls.push(`chmod:${descriptor}`); },
    sync(descriptor) {
      calls.push(`fsync:${descriptor}`);
      if (input?.failAt === "sync") throw new Error("sync failed");
    },
    close(descriptor) { calls.push(`close:${descriptor}`); },
    replace(source, target) {
      calls.push(`replace:${source}:${target}`);
      replacements.push(source);
      if (input?.failAt === "replace") throw new Error("replace failed");
    },
    remove(path) { calls.push(`remove:${path}`); },
    syncDirectory(path) {
      calls.push(`dirsync:${path}`);
      if (input?.failDirectorySync) throw new Error("directory sync unsupported");
    },
    uniqueId() {
      const id = ids.shift();
      if (!id) throw new Error("test id exhausted");
      return id;
    },
  };
}

describe("Discord owner-only atomic file replacement", () => {
  it("publishes a 0600 file and leaves no same-directory temporary file", () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    replaceOwnerOnlyAtomic(path, "{\"state\":1}");
    replaceOwnerOnlyAtomic(path, "{\"state\":2}");

    expect(readFileSync(path, "utf8")).toBe("{\"state\":2}");
    expect(readdirSync(directory)).toEqual(["state.json"]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("uses a distinct exclusive temporary path for independent writers", () => {
    const fs = recordingFs({ ids: ["writer-a", "writer-b"] });
    replaceOwnerOnlyAtomic("/trusted/status.json", "first", fs);
    replaceOwnerOnlyAtomic("/trusted/status.json", "second", fs);

    expect(fs.replacements).toHaveLength(2);
    expect(new Set(fs.replacements).size).toBe(2);
    expect(fs.replacements[0]).toMatch(/\/trusted\/\.status\.json\.\d+\.writer-a\.tmp$/);
    expect(fs.replacements[1]).toMatch(/\/trusted\/\.status\.json\.\d+\.writer-b\.tmp$/);
  });

  it("syncs and closes the owner-only file before publishing it", () => {
    const fs = recordingFs();
    replaceOwnerOnlyAtomic("/trusted/state.json", "contents", fs);

    const stages = fs.calls.map((call) => call.split(":")[0]);
    expect(stages).toEqual([
      "mkdir", "open", "write", "chmod", "fsync", "close", "replace", "dirsync",
    ]);
  });

  it.each(["write", "sync", "replace"] as const)(
    "closes and removes the unpublished temporary file when %s fails",
    (failAt) => {
      const fs = recordingFs({ failAt });
      expect(() => replaceOwnerOnlyAtomic("/trusted/state.json", "contents", fs))
        .toThrow(`${failAt} failed`);
      expect(fs.calls.some((call) => call.startsWith("remove:/trusted/.state.json."))).toBe(true);
      if (failAt !== "replace") {
        expect(fs.calls.some((call) => call === "close:17")).toBe(true);
      }
    },
  );

  it("does not remove a colliding temporary file that this writer did not create", () => {
    const fs = recordingFs({ failAt: "open" });
    expect(() => replaceOwnerOnlyAtomic("/trusted/state.json", "contents", fs))
      .toThrow("open failed");
    expect(fs.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it("keeps a successfully published file when directory sync is unsupported", () => {
    const fs = recordingFs({ failDirectorySync: true });
    expect(() => replaceOwnerOnlyAtomic("/trusted/state.json", "contents", fs)).not.toThrow();
    expect(fs.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });
});
