import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface OwnerOnlyAtomicFileSystem {
  mkdir(path: string): void;
  openExclusive(path: string): number;
  write(descriptor: number, contents: string): void;
  restrictToOwner(descriptor: number): void;
  sync(descriptor: number): void;
  close(descriptor: number): void;
  replace(source: string, target: string): void;
  remove(path: string): void;
  syncDirectory(path: string): void;
  uniqueId(): string;
}

function makeNodeFileSystem(): OwnerOnlyAtomicFileSystem {
  return {
    mkdir(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    openExclusive(path) {
      return openSync(path, "wx", 0o600);
    },
    write(descriptor, contents) {
      writeFileSync(descriptor, contents, { encoding: "utf8" });
    },
    restrictToOwner(descriptor) {
      if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    },
    sync(descriptor) {
      fsyncSync(descriptor);
    },
    close(descriptor) {
      closeSync(descriptor);
    },
    replace(source, target) {
      renameSync(source, target);
    },
    remove(path) {
      rmSync(path, { force: true });
    },
    syncDirectory(path) {
      if (process.platform === "win32") return;
      const descriptor = openSync(path, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    },
    uniqueId() {
      return randomUUID();
    },
  };
}

export function replaceOwnerOnlyAtomic(
  path: string,
  contents: string,
  fs: OwnerOnlyAtomicFileSystem = makeNodeFileSystem(),
): void {
  const directory = dirname(path);
  fs.mkdir(directory);
  const temp = join(directory, `.${basename(path)}.${process.pid}.${fs.uniqueId()}.tmp`);
  let descriptor: number | undefined;
  let created = false;
  let published = false;
  try {
    descriptor = fs.openExclusive(temp);
    created = true;
    fs.write(descriptor, contents);
    fs.restrictToOwner(descriptor);
    fs.sync(descriptor);
    fs.close(descriptor);
    descriptor = undefined;
    fs.replace(temp, path);
    published = true;
    try {
      fs.syncDirectory(directory);
    } catch {
      // Directory fsync is unavailable on some filesystems and platforms.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.close(descriptor); } catch { /* best effort */ }
    }
    if (created && !published) {
      try { fs.remove(temp); } catch { /* best effort */ }
    }
    throw error;
  }
}
