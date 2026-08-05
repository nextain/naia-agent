#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, statSync, writeSync } from "node:fs";
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
  verifyExistingSeal = false, beforeFinalEvidenceCheck }) {
  const receiptPath = resolve(inputPath);
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit must be full 40-hex");
  const repositoryRoot = git(dirname(receiptPath), ["rev-parse", "--show-toplevel"]);
  const receiptParentPath = dirname(receiptPath);
  const receiptParentFd = openPathFromRepository(repositoryRoot, receiptParentPath, "directory");
  const receiptParentIdentity = fstatSync(receiptParentFd);
  try {
  const receiptFd = openChildNoFollow(receiptParentFd, basename(receiptPath), "file",
    verifyExistingSeal ? constants.O_RDONLY : constants.O_RDWR);
  const receiptIdentity = fstatSync(receiptFd);
  try {
  const receiptBytes = readFileSync(receiptFd);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (receipt.status !== "passed" || receipt.claimAllowed !== true || !Array.isArray(receipt.receipts)) {
    throw new Error("only a passed, claim-allowed mixed-team receipt can be sealed");
  }
  validateExecutionEvidence(receipt.executionEvidence, repositoryRoot, sourceCommit, requireCurrentSourceMatch);

  const artifactRoot = `${receiptPath}.artifacts`;
  const artifactFd = openChildNoFollow(receiptParentFd, basename(artifactRoot), "directory", constants.O_RDONLY);
  try {
  const artifactIdentity = fstatSync(artifactFd);
  const artifactFdPath = `/proc/self/fd/${artifactFd}`;
  const expectedArtifactRoot = relative(repositoryRoot, artifactRoot).split("\\").join("/");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.runId)
    || receipt.artifactBindingPath !== expectedArtifactRoot || !isAbsolute(receipt.executionArtifactRoot)
    || (!verifyExistingSeal && receipt.executionArtifactRoot !== realpathSync(artifactFdPath))) {
    throw new Error("live evidence run ID or artifact binding does not match its execution path");
  }
  const initialSqliteNames = readdirSync(artifactFdPath).filter((name) => name.startsWith("team.db")).sort();
  if (!initialSqliteNames.includes("team.db")
    || initialSqliteNames.some((name) => !["team.db", "team.db-shm", "team.db-wal"].includes(name))) {
    throw new Error("SQLite evidence contains an unexpected journal or sidecar");
  }
  for (const name of initialSqliteNames) {
    const bytes = readChildNoFollow(artifactFd, name);
    if (name === "team.db-wal" && bytes.length !== 0) {
      throw new Error("SQLite WAL must be checkpointed and empty before sealing");
    }
  }
  if (!verifyExistingSeal) normalizeSqliteToDeleteJournal(join(artifactFdPath, "team.db"));
  const sqliteNames = readdirSync(artifactFdPath).filter((name) => name.startsWith("team.db")).sort();
  if (JSON.stringify(sqliteNames) !== JSON.stringify(["team.db"])) {
    throw new Error("SQLite evidence is not a checkpointed self-contained database");
  }
  if (process.platform !== "linux") throw new Error("secure descriptor-backed SQLite evidence verification requires Linux");
  const databaseFd = openChildNoFollow(artifactFd, "team.db", "file", constants.O_RDONLY);
  let databaseIdentity; let databaseBytes; let sqliteFiles; let runs; let events;
  try {
    databaseIdentity = fstatSync(databaseFd);
    databaseBytes = readFileSync(databaseFd);
    sqliteFiles = [{ path: "team.db", byteLength: databaseBytes.length, sha256: sha256(databaseBytes) }];
    const database = new Database(`/proc/self/fd/${databaseFd}`, { readonly: true, fileMustExist: true });
    try {
      runs = database.prepare("SELECT dispatch_id,version,fingerprint,state,snapshot_json FROM issue_team_runs").all();
      events = database.prepare("SELECT dispatch_id,sequence,event_type,state FROM issue_team_events ORDER BY dispatch_id,sequence").all();
    } finally { database.close(); }
    if (sha256(readFileSync(`/proc/self/fd/${databaseFd}`)) !== sqliteFiles[0].sha256) {
      throw new Error("SQLite evidence changed while its durable state was queried");
    }
    assertChildMatchesDescriptor(artifactFd, "team.db", databaseIdentity, "file");
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
  validateDurableReceipts(snapshot, receipt.profile);
  validateOutcomeSchemas(snapshot);
  for (const roleReceipt of projected) {
    const role = receipt.profile?.roles?.[roleReceipt.workerRole];
    if (!role || role.agentKind !== roleReceipt.agentKind || role.binding?.provider !== roleReceipt.provider
      || role.binding?.model !== roleReceipt.model || role.binding?.reasoningEffort !== roleReceipt.reasoningEffort) {
      throw new Error("profile role binding does not match durable receipt evidence");
    }
  }

  const fixtureFd = openChildNoFollow(artifactFd, "fixture", "directory", constants.O_RDONLY);
  const fixtureFdPath = `/proc/self/fd/${fixtureFd}`;
  let fixture;
  try {
    fixture = readdirSync(fixtureFdPath).sort().map((name) => {
      const bytes = readChildNoFollow(fixtureFd, name);
      return { path: name, byteLength: bytes.length, sha256: sha256(bytes), hex: bytes.toString("hex") };
    });
  } finally { closeSync(fixtureFd); }
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
  const claimScope = { sessionIdentity: "provider_reported", providerIdentity: "adapter_declared_not_provider_observed",
    modelIdentity: "adapter_requested_not_provider_observed",
    capability: "mixed_adapter_execution", verificationPortability: "linux_clean_checkout_after_locked_install_and_build" };
  const convergencePaths = coreResult.repairCycles === 0 ? [{
    roles: ["explorer", "implementer", "tester", "reviewer"],
    decisions: ["explorer:proceed", "implementer:implemented", "tester:pass", "reviewer:clean"],
  }] : coreResult.repairCycles === 1 ? [{
    roles: ["explorer", "implementer", "tester", "implementer", "tester", "reviewer"],
    decisions: ["explorer:proceed", "implementer:implemented", "tester:fail", "implementer:implemented",
      "tester:pass", "reviewer:clean"],
  }, {
    roles: ["explorer", "implementer", "tester", "reviewer", "implementer", "tester", "reviewer"],
    decisions: ["explorer:proceed", "implementer:implemented", "tester:pass", "reviewer:changes_requested",
      "implementer:implemented", "tester:pass", "reviewer:clean"],
  }] : [];
  const observedRoles = projected.map((value) => value.workerRole);
  const observedDecisions = snapshot.outcomes?.map((value) => `${value.role}:${value.decision}`);
  const convergenceMatches = convergencePaths.some((path) => JSON.stringify(observedRoles) === JSON.stringify(path.roles)
    && JSON.stringify(observedDecisions) === JSON.stringify(path.decisions));
  if (receipt.schemaVersion !== 1 || receipt.benchmarkId !== "mixed-issue-team-live-v1"
    || receipt.maximumPaidCalls !== 7 || receipt.paidCalls !== projected.length
    || coreResult.ok !== true || !convergenceMatches
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
  beforeFinalEvidenceCheck?.();
  assertArtifactSnapshot(artifactFd, databaseIdentity, sqliteFiles[0].sha256, fixture);
  assertChildMatchesDescriptor(receiptParentFd, basename(artifactRoot), artifactIdentity, "directory");
  assertPathMatchesDescriptor(receiptParentPath, receiptParentIdentity, "directory");
  if (verifyExistingSeal) {
    if (!receipt.embeddedEvidence || receipt.artifactRoot !== expectedArtifactRoot
      || JSON.stringify(receipt.embeddedEvidence) !== JSON.stringify(expectedEmbeddedEvidence)
      || JSON.stringify(receipt.assertions) !== JSON.stringify(expectedAssertions)) {
      throw new Error("sealed receipt evidence does not match the immutable execution artifacts");
    }
    if (expectedArtifactRoot.startsWith(".agents/reviews/")) {
      assertTrackedEvidence(repositoryRoot, receiptPath, artifactRoot, receiptBytes, databaseBytes, fixture);
    }
    return receipt;
  }
  if (receipt.embeddedEvidence !== undefined) throw new Error("receipt is already sealed; use sealed verification mode");
  const sealed = { ...receipt, artifactRoot: expectedArtifactRoot, embeddedEvidence: expectedEmbeddedEvidence,
    assertions: expectedAssertions };
  writeJsonBoundFile(receiptParentFd, basename(receiptPath), receiptFd, receiptIdentity, receiptBytes, sealed);
  assertArtifactSnapshot(artifactFd, databaseIdentity, sqliteFiles[0].sha256, fixture);
  assertChildMatchesDescriptor(receiptParentFd, basename(artifactRoot), artifactIdentity, "directory");
  assertPathMatchesDescriptor(receiptParentPath, receiptParentIdentity, "directory");
  return sealed;
  } finally { closeSync(artifactFd); }
  } finally { closeSync(receiptFd); }
  } finally { closeSync(receiptParentFd); }
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
  validateExecutableEvidence(value.executables, repositoryRoot);
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

function validateExecutableEvidence(value, cwd) {
  if (!value || Object.keys(value).sort().join(",") !== "claude,codex,node,opencode") {
    throw new Error("coding executable evidence is incomplete");
  }
  for (const command of ["node", "claude", "opencode", "codex"]) {
    const executable = value[command];
    if (executable?.command !== command || !isAbsolute(executable.path)
      || !/^[0-9a-f]{64}$/u.test(executable.sha256) || typeof executable.version !== "string"
      || !executable.version || executable.version.length > 512) throw new Error("coding executable evidence is invalid");
    const currentPath = command === "node" ? realpathSync(process.execPath)
      : realpathSync(process.env[{ claude: "CLAUDE_BIN", opencode: "OPENCODE_BIN", codex: "CODEX_BIN" }[command]]
        || execFileSync(process.platform === "win32" ? "where" : "which", [command],
          { cwd, encoding: "utf8" }).trim().split(/\r?\n/u)[0]);
    const currentVersion = command === "node" ? process.version
      : execFileSync(currentPath, ["--version"], { cwd, encoding: "utf8", timeout: 15_000 }).trim();
    if (sha256(readFileSync(currentPath)) !== executable.sha256 || currentVersion !== executable.version) {
      throw new Error(`coding executable changed during live run: ${command}`);
    }
    if (command === "codex" && JSON.stringify(executable.packageClosures)
      !== JSON.stringify(captureCodexPackageClosures(currentPath))) {
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

function validateDurableReceipts(snapshot, profile) {
  const sessions = new Set(); const executions = new Set();
  const allowedKeys = ["role", "workerRole", "agentProfileId", "agentKind", "provider", "model", "reasoningEffort",
    "sessionId", "executionId", "idempotencyKey", "sessionEvidenceSource", "tokenCountsAvailable", "inputTokens",
    "cachedInputTokens", "outputTokens", "latencyMs", "modelEvidenceSource", "cost"];
  for (let index = 0; index < snapshot.receipts.length; index += 1) {
    const value = snapshot.receipts[index]; const declared = profile.roles?.[value.workerRole];
    if (!value || value.role !== "worker" || !declared || value.agentProfileId !== declared.agentProfileId
      || value.idempotencyKey !== `${snapshot.dispatchId}:${value.workerRole}:${index + 1}`
      || !Number.isFinite(value.latencyMs) || value.latencyMs < 0
      || Object.keys(value).some((key) => !allowedKeys.includes(key))
      || sessions.has(value.sessionId) || executions.has(value.executionId)) {
      throw new Error("durable worker receipt invariants are inconsistent");
    }
    for (const tokens of [value.inputTokens, value.cachedInputTokens, value.outputTokens]) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("durable worker receipt accounting is invalid");
    }
    if (!value.tokenCountsAvailable && (value.inputTokens !== 0 || value.cachedInputTokens !== 0
      || value.outputTokens !== 0 || value.cost?.state === "measured")) {
      throw new Error("durable worker unavailable usage evidence is invalid");
    }
    if (value.cost?.state === "measured"
      ? !Number.isFinite(value.cost.usd) || value.cost.usd < 0 || !value.cost.source?.trim()
      : value.cost?.state !== "unavailable" || !value.cost.reason?.trim()) {
      throw new Error("durable worker receipt cost evidence is invalid");
    }
    sessions.add(value.sessionId); executions.add(value.executionId);
  }
}

function validateOutcomeSchemas(snapshot) {
  if (!Array.isArray(snapshot.outcomes) || snapshot.outcomes.length !== snapshot.receipts.length) {
    throw new Error("durable outcome evidence is incomplete");
  }
  for (let index = 0; index < snapshot.outcomes.length; index += 1) {
    const outcome = snapshot.outcomes[index]; const codes = new Set();
    if (!outcome || outcome.version !== 1 || outcome.role !== snapshot.receipts[index].workerRole
      || typeof outcome.summary !== "string" || Buffer.byteLength(outcome.summary, "utf8") > 8 * 1024
      || !Array.isArray(outcome.findings) || outcome.findings.length > 32
      || Object.keys(outcome).some((key) => !["version", "role", "decision", "summary", "findings"].includes(key))) {
      throw new Error("durable outcome schema is invalid");
    }
    for (const finding of outcome.findings) {
      if (!finding || typeof finding.code !== "string" || !finding.code || finding.code.length > 80
        || codes.has(finding.code) || typeof finding.message !== "string"
        || Buffer.byteLength(finding.message, "utf8") > 2 * 1024
        || Object.keys(finding).some((key) => !["code", "message"].includes(key))) {
        throw new Error("durable outcome finding schema is invalid");
      }
      codes.add(finding.code);
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

function openPathFromRepository(repositoryRoot, targetPath, expectedKind) {
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

function openChildNoFollow(parentFd, name, expectedKind, flags) {
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

function readChildNoFollow(parentFd, name) {
  const fd = openChildNoFollow(parentFd, name, "file", constants.O_RDONLY);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

function normalizeSqliteToDeleteJournal(path) {
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

function assertChildMatchesDescriptor(parentFd, name, descriptorIdentity, expectedKind) {
  const fd = openChildNoFollow(parentFd, name, expectedKind, constants.O_RDONLY);
  try {
    const current = fstatSync(fd);
    if (current.dev !== descriptorIdentity.dev || current.ino !== descriptorIdentity.ino) {
      throw new Error("evidence entry changed during descriptor-backed verification");
    }
  } finally { closeSync(fd); }
}

function assertPathMatchesDescriptor(path, descriptorIdentity, expectedKind) {
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

function assertArtifactSnapshot(artifactFd, databaseIdentity, databaseSha256, fixture) {
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

function assertTrackedEvidence(repositoryRoot, receiptPath, artifactRoot, receiptBytes, databaseBytes, fixture) {
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

function writeJsonBoundFile(parentFd, name, receiptFd, receiptIdentity, expectedOriginalBytes, value) {
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
