import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readdirSync,
  writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { sha256 } from "./mixed-live-seal-utils.mjs";

export function openPathFromRepository(repositoryRoot, targetPath, expectedKind) {
  const root = resolve(repositoryRoot); const target = resolve(targetPath); const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
    throw new Error("evidence path must be inside the repository");
  }
  let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
  try {
    const parts = pathFromRoot.split(/[\\/]/u);
    for (let index = 0; index < parts.length; index += 1) {
      const next = openChildNoFollow(fd, parts[index], index === parts.length - 1 ? expectedKind : "directory",
        constants.O_RDONLY);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd); throw error;
  }
}

export function openChildNoFollow(parentFd, name, expectedKind, flags) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("evidence child name is invalid");
  }
  const directoryFlag = expectedKind === "directory" ? constants.O_DIRECTORY : 0;
  let fd;
  try {
    fd = openSync(`/proc/self/fd/${parentFd}/${name}`, flags | directoryFlag | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes(error?.code)) throw new Error("evidence path contains a symbolic link");
    throw error;
  }
  try {
    const stat = fstatSync(fd); const valid = expectedKind === "file" ? stat.isFile() : stat.isDirectory();
    if (!valid) throw new Error(`evidence path is not a regular ${expectedKind}`);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function readChildNoFollow(parentFd, name) {
  const fd = openChildNoFollow(parentFd, name, "file", constants.O_RDONLY);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

export function normalizeSqliteToDeleteJournal(path) {
  if (process.platform !== "linux") throw new Error("secure descriptor-backed SQLite evidence verification requires Linux");
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("SQLite evidence is not a regular file");
    const database = new Database(`/proc/self/fd/${fd}`, { fileMustExist: true });
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
      if (database.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
        throw new Error("SQLite evidence could not be normalized to a self-contained journal mode");
      }
    } finally { database.close(); }
  } finally { closeSync(fd); }
}

export function assertChildMatchesDescriptor(parentFd, name, descriptorIdentity, expectedKind) {
  const fd = openChildNoFollow(parentFd, name, expectedKind, constants.O_RDONLY);
  try {
    const current = fstatSync(fd);
    if (current.dev !== descriptorIdentity.dev || current.ino !== descriptorIdentity.ino) {
      throw new Error("evidence entry changed during descriptor-backed verification");
    }
  } finally { closeSync(fd); }
}

export function assertPathMatchesDescriptor(path, descriptorIdentity, expectedKind) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY
      | (expectedKind === "directory" ? constants.O_DIRECTORY : 0) | (constants.O_NOFOLLOW ?? 0));
    const current = fstatSync(fd); const kindMatches = expectedKind === "file" ? current.isFile() : current.isDirectory();
    if (!kindMatches || current.dev !== descriptorIdentity.dev || current.ino !== descriptorIdentity.ino) {
      throw new Error("evidence path changed during descriptor-backed verification");
    }
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function assertArtifactSnapshot(artifactFd, databaseIdentity, databaseSha256, fixture) {
  const names = readdirSync(`/proc/self/fd/${artifactFd}`).filter((name) => name.startsWith("team.db")).sort();
  if (JSON.stringify(names) !== JSON.stringify(["team.db"])) {
    throw new Error("SQLite evidence changed before the sealing commit point");
  }
  const databaseFd = openChildNoFollow(artifactFd, "team.db", "file", constants.O_RDONLY);
  try {
    const current = fstatSync(databaseFd);
    if (current.dev !== databaseIdentity.dev || current.ino !== databaseIdentity.ino
      || sha256(readFileSync(databaseFd)) !== databaseSha256) {
      throw new Error("SQLite evidence changed before the sealing commit point");
    }
  } finally { closeSync(databaseFd); }
  const fixtureFd = openChildNoFollow(artifactFd, "fixture", "directory", constants.O_RDONLY);
  try {
    const current = readdirSync(`/proc/self/fd/${fixtureFd}`).sort().map((name) => {
      const bytes = readChildNoFollow(fixtureFd, name);
      return { path: name, byteLength: bytes.length, sha256: sha256(bytes), hex: bytes.toString("hex") };
    });
    if (JSON.stringify(current) !== JSON.stringify(fixture)) {
      throw new Error("fixture evidence changed before the sealing commit point");
    }
  } finally { closeSync(fixtureFd); }
}

export function assertTrackedEvidence(repositoryRoot, receiptPath, artifactRoot, receiptBytes, databaseBytes, fixture) {
  const paths = [receiptPath, join(artifactRoot, "team.db"), join(artifactRoot, "fixture/result.txt"),
    join(artifactRoot, "fixture/seed.txt")].map((path) => relative(repositoryRoot, path).split("\\").join("/"));
  for (const path of paths) execFileSync("git", ["ls-files", "--error-unmatch", path],
    { cwd: repositoryRoot, stdio: "ignore" });
  const expected = [receiptBytes, databaseBytes, ...fixture.map((value) => Buffer.from(value.hex, "hex"))];
  for (let index = 0; index < paths.length; index += 1) {
    if (!execFileSync("git", ["show", `HEAD:${paths[index]}`], { cwd: repositoryRoot }).equals(expected[index])) {
      throw new Error("tracked evidence bytes do not match immutable HEAD");
    }
  }
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...paths], { cwd: repositoryRoot });
  execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--", ...paths], { cwd: repositoryRoot });
}

export function writeJsonBoundFile(parentFd, name, receiptFd, receiptIdentity, expectedOriginalBytes, value) {
  assertChildMatchesDescriptor(parentFd, name, receiptIdentity, "file");
  if (!readFileSync(`/proc/self/fd/${receiptFd}`).equals(expectedOriginalBytes)) {
    throw new Error("receipt changed before the bound seal write");
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  ftruncateSync(receiptFd, 0);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(receiptFd, bytes, offset, bytes.length - offset, offset);
  fsyncSync(receiptFd);
  assertChildMatchesDescriptor(parentFd, name, receiptIdentity, "file");
  if (!readFileSync(`/proc/self/fd/${receiptFd}`).equals(bytes)) {
    throw new Error("sealed receipt bytes changed during the bound write");
  }
}
