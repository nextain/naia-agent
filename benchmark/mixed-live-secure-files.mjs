import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

export function createChildFileNoFollow(parentFd, name, mode = 0o600) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("evidence child name is invalid");
  }
  const fd = openSync(`/proc/self/fd/${parentFd}/${name}`, constants.O_CREAT | constants.O_EXCL
    | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("evidence path is not a regular file");
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

export function fsyncArtifactEvidence(artifactFd, fixture) {
  const databaseNames = readdirSync(`/proc/self/fd/${artifactFd}`).filter((name) => name.startsWith("team.db")).sort();
  if (JSON.stringify(databaseNames) !== JSON.stringify(["team.db"])) {
    throw new Error("SQLite evidence changed before durable synchronization");
  }
  const databaseFd = openChildNoFollow(artifactFd, "team.db", "file", constants.O_RDONLY);
  try { fsyncSync(databaseFd); } finally { closeSync(databaseFd); }
  const fixtureFd = openChildNoFollow(artifactFd, "fixture", "directory", constants.O_RDONLY);
  try {
    const names = readdirSync(`/proc/self/fd/${fixtureFd}`).sort();
    const expectedNames = fixture.map((value) => value.path).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
      throw new Error("fixture evidence changed before durable synchronization");
    }
    for (const name of names) {
      const fd = openChildNoFollow(fixtureFd, name, "file", constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    fsyncSync(fixtureFd);
  } finally { closeSync(fixtureFd); }
  fsyncSync(artifactFd);
}

export function assertTrackedEvidence(repositoryRoot, evidenceCommit, receiptPath, artifactRoot, receiptBytes,
  databaseBytes, fixture) {
  if (!/^[0-9a-f]{40}$/u.test(evidenceCommit)) throw new Error("evidence commit must be full 40-hex");
  const resolvedEvidenceCommit = execFileSync("git", ["rev-parse", `${evidenceCommit}^{commit}`],
    { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (resolvedEvidenceCommit !== evidenceCommit) throw new Error("evidence commit did not resolve immutably");
  const paths = [receiptPath, join(artifactRoot, "team.db"), join(artifactRoot, "fixture/result.txt"),
    join(artifactRoot, "fixture/seed.txt")].map((path) => relative(repositoryRoot, path).split("\\").join("/"));
  for (const path of paths) execFileSync("git", ["ls-files", "--error-unmatch", path],
    { cwd: repositoryRoot, stdio: "ignore" });
  const expected = [receiptBytes, databaseBytes, ...fixture.map((value) => Buffer.from(value.hex, "hex"))];
  for (let index = 0; index < paths.length; index += 1) {
    if (!execFileSync("git", ["show", `${resolvedEvidenceCommit}:${paths[index]}`],
      { cwd: repositoryRoot }).equals(expected[index])) {
      throw new Error("tracked evidence bytes do not match immutable evidence commit");
    }
  }
  execFileSync("git", ["diff", "--quiet", resolvedEvidenceCommit, "--", ...paths], { cwd: repositoryRoot });
  execFileSync("git", ["diff", "--cached", "--quiet", resolvedEvidenceCommit, "--", ...paths],
    { cwd: repositoryRoot });
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

export function assertNoPublicationRecoveryEntries(parentFd, name) {
  const prefixes = [`.${name}.seal-`, `.${name}.unsealed-backup-`];
  if (readdirSync(`/proc/self/fd/${parentFd}`).some((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))) {
    throw new Error("incomplete receipt publication recovery entry exists");
  }
}

export function publishJsonAtomically(parentFd, name, receiptFd, receiptIdentity, expectedOriginalBytes, value,
  hooks = {}) {
  assertChildMatchesDescriptor(parentFd, name, receiptIdentity, "file");
  if (!readFileSync(`/proc/self/fd/${receiptFd}`).equals(expectedOriginalBytes)) {
    throw new Error("receipt changed before atomic publication");
  }
  const temporaryPrefix = `.${name}.seal-`; const backupPrefix = `.${name}.unsealed-backup-`;
  assertNoPublicationRecoveryEntries(parentFd, name);
  const temporaryName = `${temporaryPrefix}${randomUUID()}`;
  const backupName = `${backupPrefix}${randomUUID()}`;
  const temporaryFd = createChildFileNoFollow(parentFd, temporaryName);
  let temporaryExists = true; let backupExists = false; let rollbackFailed = false; let published = false;
  try {
    const temporaryIdentity = fstatSync(temporaryFd);
    writeJsonBoundFile(parentFd, temporaryName, temporaryFd, temporaryIdentity, Buffer.alloc(0), value);
    // Persist the complete temporary entry first. The caller's final evidence
    // guard runs at the publication boundary, after every temporary write and
    // before the original receipt and temporary entry are revalidated.
    fsyncSync(parentFd);
    hooks.beforeRename?.();
    hooks.afterBeforeRename?.();
    assertChildMatchesDescriptor(parentFd, name, receiptIdentity, "file");
    if (!readFileSync(`/proc/self/fd/${receiptFd}`).equals(expectedOriginalBytes)) {
      throw new Error("receipt changed before atomic publication");
    }
    assertChildMatchesDescriptor(parentFd, temporaryName, temporaryIdentity, "file");
    // Preserve the original nonclaimable receipt under a private recovery name.
    // A crash before completion therefore leaves either no canonical receipt or
    // a detectable recovery entry; sealed verification fails closed on either.
    renameSync(`/proc/self/fd/${parentFd}/${name}`, `/proc/self/fd/${parentFd}/${backupName}`);
    backupExists = true;
    fsyncSync(parentFd);
    renameSync(`/proc/self/fd/${parentFd}/${temporaryName}`, `/proc/self/fd/${parentFd}/${name}`);
    temporaryExists = false;
    hooks.afterRenameBeforeDirectorySync?.();
    // rename publication is not durable until the containing directory is
    // synchronized after the namespace change.
    fsyncSync(parentFd);
    unlinkSync(`/proc/self/fd/${parentFd}/${backupName}`);
    backupExists = false;
    fsyncSync(parentFd);
    published = true;
  } catch (error) {
    if (backupExists) {
      try {
        renameSync(`/proc/self/fd/${parentFd}/${backupName}`, `/proc/self/fd/${parentFd}/${name}`);
        backupExists = false;
        fsyncSync(parentFd);
      } catch (rollbackError) {
        rollbackFailed = true;
        throw new AggregateError([error, rollbackError], "receipt publication rollback failed; outcome is unknown");
      }
    }
    throw error;
  } finally {
    try { closeSync(temporaryFd); } catch (error) { if (!published) throw error; }
    if (temporaryExists) {
      try { unlinkSync(`/proc/self/fd/${parentFd}/${temporaryName}`); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (backupExists && !rollbackFailed) {
      try { unlinkSync(`/proc/self/fd/${parentFd}/${backupName}`); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}
