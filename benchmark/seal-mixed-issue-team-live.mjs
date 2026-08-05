#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const scriptPath = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

export function captureMixedLiveExecutionEvidence(repositoryRoot) {
  const sourceCommit = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("mixed live source commit is invalid");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repositoryRoot });
  execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--"], { cwd: repositoryRoot });
  for (const path of ["benchmark/run-mixed-issue-team-live.mjs", "benchmark/seal-mixed-issue-team-live.mjs"]) {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { cwd: repositoryRoot, stdio: "ignore" });
  }
  const compilerPath = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [compilerPath, "-p", join(repositoryRoot, "tsconfig.json")], { cwd: repositoryRoot, stdio: "pipe" });
  const executables = {
    node: captureNodeExecutable(),
    claude: captureExecutable(repositoryRoot, "claude", "CLAUDE_BIN"),
    opencode: captureExecutable(repositoryRoot, "opencode", "OPENCODE_BIN"),
    codex: captureExecutable(repositoryRoot, "codex", "CODEX_BIN"),
  };
  return {
    sourceCommit,
    sourceTree: git(repositoryRoot, ["rev-parse", `${sourceCommit}^{tree}`]),
    benchmarkScriptSha256: sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/run-mixed-issue-team-live.mjs`], { cwd: repositoryRoot })),
    sealerSha256: sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/seal-mixed-issue-team-live.mjs`], { cwd: repositoryRoot })),
    runtimeBuild: { completed: true, compilerSha256: sha256(readFileSync(compilerPath)),
      compilerClosure: digestDirectory(dirname(dirname(compilerPath))),
      sqliteClosure: captureSqliteClosure(),
      tsconfigSha256: sha256(execFileSync("git", ["show", `${sourceCommit}:tsconfig.json`], { cwd: repositoryRoot })) },
    executables,
    runtimeClosure: digestDirectory(join(repositoryRoot, "dist/main")),
  };
}

export function sealMixedIssueTeamLive({ receiptPath: inputPath, sourceCommit, requireCurrentSourceMatch = false,
  verifyExistingSeal = false }) {
  const receiptPath = resolve(inputPath);
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit must be full 40-hex");
  const repositoryRoot = git(dirname(receiptPath), ["rev-parse", "--show-toplevel"]);
  assertNoSymlinkPath(repositoryRoot, receiptPath, "file");
  const receipt = JSON.parse(readRegularFileNoFollow(receiptPath).toString("utf8"));
  if (receipt.status !== "passed" || receipt.claimAllowed !== true || !Array.isArray(receipt.receipts)) {
    throw new Error("only a passed, claim-allowed mixed-team receipt can be sealed");
  }
  validateExecutionEvidence(receipt.executionEvidence, repositoryRoot, sourceCommit, requireCurrentSourceMatch);

  const artifactRoot = `${receiptPath}.artifacts`;
  const databasePath = join(artifactRoot, "team.db");
  assertNoSymlinkPath(repositoryRoot, artifactRoot, "directory");
  assertNoSymlinkPath(repositoryRoot, databasePath, "file");
  const artifactIdentity = directoryIdentity(artifactRoot);
  const expectedArtifactRoot = relative(repositoryRoot, artifactRoot).split("\\").join("/");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.runId)
    || receipt.artifactBindingPath !== expectedArtifactRoot || !isAbsolute(receipt.executionArtifactRoot)
    || (!verifyExistingSeal && receipt.executionArtifactRoot !== realpathSync(artifactRoot))) {
    throw new Error("live evidence run ID or artifact binding does not match its execution path");
  }
  const initialSqliteNames = readdirSync(artifactRoot).filter((name) => name.startsWith("team.db")).sort();
  if (!initialSqliteNames.includes("team.db")
    || initialSqliteNames.some((name) => !["team.db", "team.db-shm", "team.db-wal"].includes(name))) {
    throw new Error("SQLite evidence contains an unexpected journal or sidecar");
  }
  for (const name of initialSqliteNames) {
    const path = join(artifactRoot, name); assertNoSymlinkPath(repositoryRoot, path, "file");
    if (name === "team.db-wal" && readRegularFileNoFollow(path).length !== 0) {
      throw new Error("SQLite WAL must be checkpointed and empty before sealing");
    }
  }
  if (!verifyExistingSeal) normalizeSqliteToDeleteJournal(databasePath);
  const sqliteNames = readdirSync(artifactRoot).filter((name) => name.startsWith("team.db")).sort();
  if (JSON.stringify(sqliteNames) !== JSON.stringify(["team.db"])) {
    throw new Error("SQLite evidence is not a checkpointed self-contained database");
  }
  if (process.platform !== "linux") throw new Error("secure descriptor-backed SQLite evidence verification requires Linux");
  const databaseFd = openRegularFileNoFollow(databasePath);
  const databaseIdentity = fstatSync(databaseFd);
  const databaseBytes = readFileSync(databaseFd);
  const sqliteFiles = [{ path: "team.db", byteLength: databaseBytes.length, sha256: sha256(databaseBytes) }];
  let runs; let events;
  try {
    const database = new Database(`/proc/self/fd/${databaseFd}`, { readonly: true, fileMustExist: true });
    try {
      runs = database.prepare("SELECT dispatch_id,version,fingerprint,state,snapshot_json FROM issue_team_runs").all();
      events = database.prepare("SELECT dispatch_id,sequence,event_type,state FROM issue_team_events ORDER BY dispatch_id,sequence").all();
    } finally { database.close(); }
    assertPathMatchesFileDescriptor(databasePath, databaseIdentity);
  } finally { closeSync(databaseFd); }
  if (runs.length !== 1) throw new Error("live evidence must contain exactly one durable team run");
  const run = runs[0]; const snapshot = JSON.parse(String(run.snapshot_json));
  validateDurableRun(run, snapshot, events, receipt.runId, receipt.artifactBindingPath,
    receipt.executionArtifactRoot);
  const projected = snapshot.receipts.map(projectReceipt);
  if (JSON.stringify(projected) !== JSON.stringify(receipt.receipts)) {
    throw new Error("receipt projection does not match the durable SQLite snapshot");
  }
  const profileDigest = sha256(Buffer.from(stableJson(receipt.profile)));
  if (profileDigest !== snapshot.profileDigest) throw new Error("profile does not match the durable SQLite snapshot");
  for (const roleReceipt of projected) {
    const role = receipt.profile?.roles?.[roleReceipt.workerRole];
    if (!role || role.agentKind !== roleReceipt.agentKind || role.binding?.provider !== roleReceipt.provider
      || role.binding?.model !== roleReceipt.model || role.binding?.reasoningEffort !== roleReceipt.reasoningEffort) {
      throw new Error("profile role binding does not match durable receipt evidence");
    }
  }

  const fixtureRoot = join(artifactRoot, "fixture");
  assertNoSymlinkPath(repositoryRoot, fixtureRoot, "directory");
  const fixture = readdirSync(fixtureRoot).sort().map((name) => {
    const path = join(fixtureRoot, name); assertNoSymlinkPath(repositoryRoot, path, "file");
    const bytes = readRegularFileNoFollow(path);
    return { path: name, byteLength: bytes.length, sha256: sha256(bytes), hex: bytes.toString("hex") };
  });
  if (JSON.stringify(fixture.map(({ path }) => path)) !== JSON.stringify(["result.txt", "seed.txt"])
    || fixture[0].hex !== Buffer.from("NAIA_MIXED_TEAM_OK\n").toString("hex")
    || fixture[1].hex !== Buffer.from("SEED_MUST_STAY\n").toString("hex")) {
    throw new Error("fixture bytes do not match the live benchmark contract");
  }
  const roleKinds = Object.fromEntries(projected.map((value) => [value.workerRole, value.agentKind]));
  const coreResult = { ok: snapshot.result?.ok, changedFiles: snapshot.result?.changedFiles,
    cleanCycles: snapshot.cleanCycles, repairCycles: snapshot.repairCycles };
  const coreAssertions = { exactArtifacts: true,
    evidenceComplete: projected.length >= 4 && projected.every((value) => value.sessionId
      && value.sessionEvidenceSource === "provider_reported"
      && ["provider_reported", "adapter_requested"].includes(value.modelEvidenceSource)
      && value.executionId && value.provider && value.model),
    mixedAppsObserved: new Set(projected.map((value) => value.agentKind)).size === 3, roleKinds };
  const claimScope = { sessionIdentity: "provider_reported", modelIdentity: "adapter_requested_not_provider_observed",
    capability: "mixed_adapter_execution" };
  const expectedRoleSequence = coreResult.repairCycles === 0
    ? ["explorer", "implementer", "tester", "reviewer"]
    : coreResult.repairCycles === 1
      ? ["explorer", "implementer", "tester", "implementer", "tester", "reviewer"] : undefined;
  if (receipt.schemaVersion !== 1 || receipt.benchmarkId !== "mixed-issue-team-live-v1"
    || receipt.maximumPaidCalls !== 7 || receipt.paidCalls !== projected.length
    || coreResult.ok !== true || !expectedRoleSequence
    || JSON.stringify(projected.map((value) => value.workerRole)) !== JSON.stringify(expectedRoleSequence)
    || JSON.stringify(coreResult.changedFiles) !== JSON.stringify(["result.txt"])
    || coreResult.cleanCycles !== 1
    || coreAssertions.evidenceComplete !== true || coreAssertions.mixedAppsObserved !== true
    || JSON.stringify(receipt.claimScope) !== JSON.stringify(claimScope)
    || JSON.stringify(coreAssertions.roleKinds) !== JSON.stringify({ explorer: "claude-code",
      implementer: "opencode", tester: "codex", reviewer: "codex" })
    || JSON.stringify(receipt.result) !== JSON.stringify(coreResult)
    || JSON.stringify(pickCoreAssertions(receipt.assertions)) !== JSON.stringify(coreAssertions)) {
    throw new Error("receipt summary does not match durable state and exact fixture evidence");
  }

  const normalizedSnapshot = JSON.parse(JSON.stringify(snapshot).split(receipt.executionArtifactRoot).join("$ARTIFACT_ROOT"));
  const durableRun = { dispatchId: run.dispatch_id, version: run.version, fingerprint: run.fingerprint,
    state: run.state, normalizedSnapshot };
  const expectedEmbeddedEvidence = { ...receipt.executionEvidence, sqliteFiles,
    sqliteSha256: sqliteFiles.find((value) => value.path === "team.db").sha256,
    durableRun, durableRunSha256: sha256(Buffer.from(JSON.stringify(durableRun))), events, fixture };
  const expectedAssertions = { ...coreAssertions, durableEvidenceEmbedded: true, receiptMatchesDurableSnapshot: true };
  assertSameDirectory(artifactRoot, artifactIdentity);
  if (verifyExistingSeal) {
    if (!receipt.embeddedEvidence || receipt.artifactRoot !== expectedArtifactRoot
      || JSON.stringify(receipt.embeddedEvidence) !== JSON.stringify(expectedEmbeddedEvidence)
      || JSON.stringify(receipt.assertions) !== JSON.stringify(expectedAssertions)) {
      throw new Error("sealed receipt evidence does not match the immutable execution artifacts");
    }
    return receipt;
  }
  if (receipt.embeddedEvidence !== undefined) throw new Error("receipt is already sealed; use sealed verification mode");
  const sealed = { ...receipt, artifactRoot: expectedArtifactRoot, embeddedEvidence: expectedEmbeddedEvidence,
    assertions: expectedAssertions };
  writeJsonAtomic(receiptPath, sealed);
  return sealed;
}

function validateExecutionEvidence(value, repositoryRoot, sourceCommit, requireCurrentSourceMatch) {
  const compilerPath = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  if (!value || value.sourceCommit !== sourceCommit
    || value.sourceTree !== git(repositoryRoot, ["rev-parse", `${sourceCommit}^{tree}`])
    || value.benchmarkScriptSha256 !== sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/run-mixed-issue-team-live.mjs`], { cwd: repositoryRoot }))
    || value.sealerSha256 !== sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/seal-mixed-issue-team-live.mjs`], { cwd: repositoryRoot }))
    || value.runtimeBuild?.completed !== true || value.runtimeBuild.compilerSha256 !== sha256(readFileSync(compilerPath))
    || JSON.stringify(value.runtimeBuild.compilerClosure) !== JSON.stringify(digestDirectory(dirname(dirname(compilerPath))))
    || JSON.stringify(value.runtimeBuild.sqliteClosure) !== JSON.stringify(captureSqliteClosure())
    || value.runtimeBuild.tsconfigSha256 !== sha256(execFileSync("git", ["show", `${sourceCommit}:tsconfig.json`], { cwd: repositoryRoot }))) {
    throw new Error("execution evidence is not bound to the declared source commit");
  }
  validateExecutableEvidence(value.executables, true);
  const currentBenchmarkSha256 = sha256(readFileSync(join(repositoryRoot, "benchmark/run-mixed-issue-team-live.mjs")));
  const currentSealerSha256 = sha256(readFileSync(join(repositoryRoot, "benchmark/seal-mixed-issue-team-live.mjs")));
  if (currentBenchmarkSha256 !== value.benchmarkScriptSha256 || currentSealerSha256 !== value.sealerSha256
    || JSON.stringify(value.runtimeClosure) !== JSON.stringify(digestDirectory(join(repositoryRoot, "dist/main")))) {
    throw new Error("current benchmark source or execution runtime closure does not match the live run");
  }
  if (requireCurrentSourceMatch) {
    const executionPaths = ["src/main", "benchmark", "tsconfig.json", "package.json", "pnpm-lock.yaml"];
    execFileSync("git", ["diff", "--quiet", sourceCommit, "--", ...executionPaths], { cwd: repositoryRoot });
    execFileSync("git", ["diff", "--cached", "--quiet", sourceCommit, "--", ...executionPaths], { cwd: repositoryRoot });
  }
}

function captureExecutable(cwd, command, environmentName) {
  const configured = process.env[environmentName]?.trim();
  const discovered = configured || execFileSync(process.platform === "win32" ? "where" : "which", [command],
    { cwd, encoding: "utf8" }).trim().split(/\r?\n/u)[0];
  if (!isAbsolute(discovered)) throw new Error(`${environmentName} must resolve to an absolute executable path`);
  const path = realpathSync(discovered); const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${command} executable is not a regular file`);
  const version = execFileSync(path, ["--version"], { cwd, encoding: "utf8", timeout: 15_000 }).trim();
  if (!version || version.length > 512) throw new Error(`${command} version evidence is invalid`);
  const packageClosures = command === "codex" ? captureCodexPackageClosures(path) : {};
  return { command, path, sha256: sha256(readFileSync(path)), version, packageClosures };
}

function captureNodeExecutable() {
  const path = realpathSync(process.execPath);
  return { command: "node", path, sha256: sha256(readFileSync(path)), version: process.version, packageClosures: {} };
}

function captureCodexPackageClosures(entryPath) {
  const packageRoot = dirname(dirname(entryPath)); const scopeRoot = join(packageRoot, "node_modules/@openai");
  const output = {};
  for (const name of readdirSync(scopeRoot).filter((value) => value.startsWith("codex-")).sort()) {
    const path = join(scopeRoot, name); if (statSync(path).isDirectory()) output[name] = digestDirectory(path);
  }
  if (Object.keys(output).length !== 1) throw new Error("Codex native package closure is ambiguous or unavailable");
  return output;
}

function validateExecutableEvidence(value, compareCurrent) {
  if (!value || Object.keys(value).sort().join(",") !== "claude,codex,node,opencode") {
    throw new Error("coding executable evidence is incomplete");
  }
  for (const command of ["node", "claude", "opencode", "codex"]) {
    const executable = value[command];
    if (executable?.command !== command || !isAbsolute(executable.path)
      || !/^[0-9a-f]{64}$/u.test(executable.sha256) || typeof executable.version !== "string"
      || !executable.version || executable.version.length > 512) throw new Error("coding executable evidence is invalid");
    if (compareCurrent && (realpathSync(executable.path) !== executable.path
      || sha256(readFileSync(executable.path)) !== executable.sha256)) {
      throw new Error(`coding executable changed during live run: ${command}`);
    }
    if (command === "codex" && JSON.stringify(executable.packageClosures)
      !== JSON.stringify(captureCodexPackageClosures(executable.path))) {
      throw new Error("Codex native package closure changed during live run");
    }
  }
}

function validateDurableRun(run, snapshot, events, runId, artifactBindingPath, executionArtifactRoot) {
  const expectedIssueId = sha256(Buffer.from(`${runId}\0${artifactBindingPath}`));
  if (run.dispatch_id !== `${runId}:dispatch:1` || run.dispatch_id !== snapshot.dispatchId
    || snapshot.issueId !== expectedIssueId || snapshot.allocation?.workspacePath !== join(executionArtifactRoot, "fixture")
    || snapshot.allocation?.worktreePath !== join(executionArtifactRoot, "fixture")) {
    throw new Error("durable run binding does not match the execution run ID and artifact path");
  }
  if (run.version !== snapshot.version || run.fingerprint !== snapshot.fingerprint
    || run.state !== snapshot.state || run.state !== "completed"
    || events.length !== snapshot.version || snapshot.version !== snapshot.receipts.length * 2 + 1) {
    throw new Error("SQLite run columns, snapshot, and event cardinality are inconsistent");
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]; const sequence = index + 1;
    const expectedType = sequence === 1 ? "team_created" : sequence === events.length ? "team_completed"
      : sequence % 2 === 0 ? "role_claimed" : "role_acknowledged";
    const expectedState = sequence === events.length ? "completed" : sequence % 2 === 0 ? "running" : "ready";
    if (event.dispatch_id !== snapshot.dispatchId || event.sequence !== sequence
      || event.event_type !== expectedType || event.state !== expectedState) {
      throw new Error("SQLite event history is inconsistent with the completed run");
    }
  }
}

function captureSqliteClosure() {
  return digestDirectory(dirname(require.resolve("better-sqlite3/package.json")));
}

function projectReceipt(value) {
  return { workerRole: value.workerRole, agentKind: value.agentKind, provider: value.provider, model: value.model,
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}), sessionId: value.sessionId,
    sessionEvidenceSource: value.sessionEvidenceSource, modelEvidenceSource: value.modelEvidenceSource,
    executionId: value.executionId,
    tokenCountsAvailable: value.tokenCountsAvailable, inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens, outputTokens: value.outputTokens, cost: value.cost };
}

function pickCoreAssertions(value) {
  return { exactArtifacts: value?.exactArtifacts, evidenceComplete: value?.evidenceComplete,
    mixedAppsObserved: value?.mixedAppsObserved, roleKinds: value?.roleKinds };
}

function digestDirectory(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) entries.push([relative(root, path).split("\\").join("/"), sha256(readFileSync(path))]);
      else throw new Error("runtime closure contains a non-regular entry");
    }
  };
  visit(root);
  return { fileCount: entries.length, manifestSha256: sha256(Buffer.from(JSON.stringify(entries))) };
}

function assertNoSymlinkPath(repositoryRoot, targetPath, expectedKind) {
  const root = resolve(repositoryRoot); const target = resolve(targetPath); const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
    throw new Error("evidence path must be inside the repository");
  }
  let cursor = root;
  for (const part of pathFromRoot.split(/[\\/]/u)) {
    cursor = join(cursor, part); const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("evidence path contains a symbolic link");
    if (cursor !== target && !stat.isDirectory()) throw new Error("evidence path parent is not a directory");
    if (cursor === target && (expectedKind === "file" ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`evidence path is not a regular ${expectedKind}`);
    }
  }
}

function openRegularFileNoFollow(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (!fstatSync(fd).isFile()) { closeSync(fd); throw new Error("evidence path is not a regular file"); }
  return fd;
}

function readRegularFileNoFollow(path) {
  const fd = openRegularFileNoFollow(path);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

function normalizeSqliteToDeleteJournal(path) {
  if (process.platform !== "linux") throw new Error("secure descriptor-backed SQLite evidence verification requires Linux");
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  if (!fstatSync(fd).isFile()) { closeSync(fd); throw new Error("SQLite evidence is not a regular file"); }
  try {
    const database = new Database(`/proc/self/fd/${fd}`, { fileMustExist: true });
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
      if (database.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
        throw new Error("SQLite evidence could not be normalized to a self-contained journal mode");
      }
    } finally { database.close(); }
  } finally { closeSync(fd); }
}

function directoryIdentity(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("evidence directory is not a regular directory");
  return { realpath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertSameDirectory(path, identity) {
  const current = directoryIdentity(path);
  if (current.realpath !== identity.realpath || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("evidence directory changed during verification");
  }
}

function assertPathMatchesFileDescriptor(path, descriptorIdentity) {
  const current = lstatSync(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== descriptorIdentity.dev
    || current.ino !== descriptorIdentity.ino) {
    throw new Error("evidence file changed during descriptor-backed verification");
  }
}

function writeJsonAtomic(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv.includes("--capture-execution-evidence")) {
    const rootIndex = process.argv.indexOf("--repository-root"); const root = process.argv[rootIndex + 1];
    if (!root) throw new Error("--capture-execution-evidence requires --repository-root");
    process.stdout.write(`${JSON.stringify(captureMixedLiveExecutionEvidence(resolve(root)))}\n`);
    process.exit(0);
  }
  const receiptIndex = process.argv.indexOf("--receipt"); const sourceIndex = process.argv.indexOf("--source-commit");
  const receiptPath = receiptIndex >= 0 ? process.argv[receiptIndex + 1] : undefined;
  const sourceCommit = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
  const sealUnsealed = process.argv.includes("--seal-unsealed"); const verifySealed = process.argv.includes("--verify-sealed");
  if (!receiptPath || !sourceCommit || sealUnsealed === verifySealed) {
    throw new Error("usage: seal-mixed-issue-team-live.mjs --receipt <path> --source-commit <commit> (--seal-unsealed|--verify-sealed)");
  }
  sealMixedIssueTeamLive({ receiptPath, sourceCommit, requireCurrentSourceMatch: true,
    verifyExistingSeal: verifySealed });
}
