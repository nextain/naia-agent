#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const scriptPath = fileURLToPath(import.meta.url);

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
      tsconfigSha256: sha256(execFileSync("git", ["show", `${sourceCommit}:tsconfig.json`], { cwd: repositoryRoot })) },
    executables,
    runtimeClosure: digestDirectory(join(repositoryRoot, "dist/main")),
  };
}

export function sealMixedIssueTeamLive({ receiptPath: inputPath, sourceCommit, requireCurrentSourceMatch = false }) {
  const receiptPath = resolve(inputPath);
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit must be full 40-hex");
  const repositoryRoot = git(dirname(receiptPath), ["rev-parse", "--show-toplevel"]);
  assertNoSymlinkPath(repositoryRoot, receiptPath, "file");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.status !== "passed" || receipt.claimAllowed !== true || !Array.isArray(receipt.receipts)) {
    throw new Error("only a passed, claim-allowed mixed-team receipt can be sealed");
  }
  validateExecutionEvidence(receipt.executionEvidence, repositoryRoot, sourceCommit, requireCurrentSourceMatch);

  const artifactRoot = `${receiptPath}.artifacts`;
  const databasePath = join(artifactRoot, "team.db");
  assertNoSymlinkPath(repositoryRoot, artifactRoot, "directory");
  assertNoSymlinkPath(repositoryRoot, databasePath, "file");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  const runs = database.prepare("SELECT dispatch_id,version,fingerprint,state,snapshot_json FROM issue_team_runs").all();
  const events = database.prepare("SELECT dispatch_id,sequence,event_type,state FROM issue_team_events ORDER BY dispatch_id,sequence").all();
  database.close();
  if (runs.length !== 1) throw new Error("live evidence must contain exactly one durable team run");
  const run = runs[0]; const snapshot = JSON.parse(String(run.snapshot_json));
  validateDurableRun(run, snapshot, events);
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
    const bytes = readFileSync(path);
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
  if (receipt.schemaVersion !== 1 || receipt.benchmarkId !== "mixed-issue-team-live-v1"
    || receipt.maximumPaidCalls !== 7 || receipt.paidCalls !== projected.length
    || JSON.stringify(receipt.result) !== JSON.stringify(coreResult)
    || JSON.stringify(pickCoreAssertions(receipt.assertions)) !== JSON.stringify(coreAssertions)) {
    throw new Error("receipt summary does not match durable state and exact fixture evidence");
  }

  const normalizedSnapshot = JSON.parse(JSON.stringify(snapshot).split(artifactRoot).join("$ARTIFACT_ROOT"));
  const durableRun = { dispatchId: run.dispatch_id, version: run.version, fingerprint: run.fingerprint,
    state: run.state, normalizedSnapshot };
  receipt.artifactRoot = relative(repositoryRoot, artifactRoot).split("\\").join("/");
  receipt.embeddedEvidence = { ...receipt.executionEvidence, sqliteSha256: sha256(readFileSync(databasePath)),
    durableRun, durableRunSha256: sha256(Buffer.from(JSON.stringify(durableRun))), events, fixture };
  receipt.assertions = { ...coreAssertions, durableEvidenceEmbedded: true, receiptMatchesDurableSnapshot: true };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

function validateExecutionEvidence(value, repositoryRoot, sourceCommit, requireCurrentSourceMatch) {
  const compilerPath = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  if (!value || value.sourceCommit !== sourceCommit
    || value.sourceTree !== git(repositoryRoot, ["rev-parse", `${sourceCommit}^{tree}`])
    || value.benchmarkScriptSha256 !== sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/run-mixed-issue-team-live.mjs`], { cwd: repositoryRoot }))
    || value.sealerSha256 !== sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/seal-mixed-issue-team-live.mjs`], { cwd: repositoryRoot }))
    || value.runtimeBuild?.completed !== true || value.runtimeBuild.compilerSha256 !== sha256(readFileSync(compilerPath))
    || JSON.stringify(value.runtimeBuild.compilerClosure) !== JSON.stringify(digestDirectory(dirname(dirname(compilerPath))))
    || value.runtimeBuild.tsconfigSha256 !== sha256(execFileSync("git", ["show", `${sourceCommit}:tsconfig.json`], { cwd: repositoryRoot }))) {
    throw new Error("execution evidence is not bound to the declared source commit");
  }
  validateExecutableEvidence(value.executables, true);
  if (requireCurrentSourceMatch) {
    execFileSync("git", ["diff", "--quiet", sourceCommit, "--"], { cwd: repositoryRoot });
    execFileSync("git", ["diff", "--cached", "--quiet", sourceCommit, "--"], { cwd: repositoryRoot });
    if (JSON.stringify(value.runtimeClosure) !== JSON.stringify(digestDirectory(join(repositoryRoot, "dist/main")))) {
      throw new Error("execution runtime closure changed before evidence sealing");
    }
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

function validateDurableRun(run, snapshot, events) {
  if (run.dispatch_id !== snapshot.dispatchId || run.version !== snapshot.version
    || run.fingerprint !== snapshot.fingerprint || run.state !== snapshot.state || run.state !== "completed"
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
  if (!receiptPath || !sourceCommit) throw new Error("usage: seal-mixed-issue-team-live.mjs --receipt <path> --source-commit <commit>");
  sealMixedIssueTeamLive({ receiptPath, sourceCommit });
}
