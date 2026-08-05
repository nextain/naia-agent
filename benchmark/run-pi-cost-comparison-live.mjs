#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { installBenchmarkProcessIsolation, makeBenchmarkGitInvocation,
  withoutBenchmarkCredentials, withoutBenchmarkIntegrityKey } from "./pi-cost-git-isolation.mjs";
import { loadPiCostContract } from "./pi-cost-contract.mjs";
import { assertTrustedRuntimeFileSetUnchanged, assertTrustedRuntimeUnchanged, captureTrustedRuntimeDigests, collectTrustedRuntimeFiles,
  collectTrustedExecutableFiles, collectTrustedPackageFiles, trustedRuntimeManifestDigest } from "./pi-cost-runtime-trust.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contract = loadPiCostContract(process.argv.slice(2),
  new URL("./orchestration/pi-cost-comparison.json", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/pi-cost-comparison/base", import.meta.url));
const outputIndex = process.argv.indexOf("--output");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) throw new Error("--output requires a path");
const outputPath = outputArgument ? resolve(outputArgument) : undefined;
const artifactRoot = outputPath ? `${outputPath}.artifacts` : undefined;
const confirmed = process.argv.includes("--confirm-paid-comparison") && process.env.NAIA_PI_COST_CONFIRM === "1";
const key = (process.env.NAIA_API_KEY ?? process.env.NAIA_ANYLLM_API_KEY)?.trim();
const journalKey = process.env.NAIA_BENCHMARK_JOURNAL_KEY;
const journalKeyId = contract.receiptAuthority.authentication.harnessJournalKeyId;
const actualJournalKeyId = journalKey ? `sha256:${createHash("sha256").update(Buffer.from(journalKey, "utf8")).digest("hex")}` : undefined;
const trustedGitPath = contract.executionAuthority?.git?.path;
const trustedGitDigest = contract.executionAuthority?.git?.digest;
delete process.env.NAIA_BENCHMARK_JOURNAL_KEY;
delete process.env.PI_BIN;
const pinnedBaseline = typeof contract.baselineDigest === "string" && contract.baselineDigest.length > 0;
const pinnedPrices = Object.values(contract.receiptAuthority.priceVersionByModel).every((value) => typeof value === "string" && value.length > 0);
const actualBaseline = digestTree(fixture);
const actualTaskDigest = `sha256:${createHash("sha256").update(JSON.stringify(contract.task)).digest("hex")}`;
const pathOccupied = Boolean(outputPath && (existsSync(outputPath) || existsSync(artifactRoot)));
const reason = pathOccupied ? "paid comparison output or artifact path already exists"
  : !confirmed ? "explicit paid-comparison confirmation missing"
  : !key ? "Naia credential unavailable"
  : contract.taskDigest !== actualTaskDigest ? "frozen benchmark task digest mismatch"
  : !pinnedBaseline ? "benchmark baseline digest is not pinned"
  : contract.baselineDigest !== actualBaseline ? "benchmark fixture baseline digest mismatch"
  : !pinnedPrices ? "model price versions are not pinned"
  : typeof trustedGitPath !== "string" || typeof trustedGitDigest !== "string" ? "trusted Git executable is not pinned"
  : !isAbsolute(trustedGitPath) || !existsSync(trustedGitPath) || !statSync(trustedGitPath).isFile()
    ? "trusted Git executable is unavailable"
  : digestFile(trustedGitPath) !== trustedGitDigest ? "trusted Git executable digest mismatch"
  : !journalKey ? "benchmark journal integrity key unavailable"
  : Buffer.byteLength(journalKey, "utf8") < 32 ? "benchmark journal integrity key is too short"
  : typeof journalKeyId !== "string" || !journalKeyId ? "benchmark journal key identity is not pinned"
  : actualJournalKeyId !== journalKeyId ? "benchmark journal key does not match its pinned identity"
  : !existsSync(join(repositoryRoot, "dist/main/composition/pi-continuous-loop.js")) ? "built Agent artifacts unavailable"
  : !outputPath ? "durable --output path is required for paid comparison"
  : undefined;
if (reason) {
  const payload = { schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "unavailable", paidCalls: 0, gatewayCalls: 0, reason,
    baselineDigest: actualBaseline, costEfficiencyClaimAllowed: false };
  if (pathOccupied) printPayload(payload); else emitPreflight(payload);
  process.exit(0);
}

const root = artifactRoot;
claimOutput({ schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
  status: "running", completedActorAttempts: 0, gatewayCalls: 0, artifactRoot });
try { mkdirSync(root, { recursive: false, mode: 0o700 }); }
catch (error) {
  writePayload({ schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "unavailable", paidCalls: 0, gatewayCalls: 0, artifactRoot,
    reason: `paid comparison artifact reservation failed: ${error instanceof Error ? error.message : String(error)}`,
    costEfficiencyClaimAllowed: false });
  process.exit(2);
}
const gitIsolationRoot = join(root, "git-isolation");
const gatewayBudgetPolicy = { maxGatewayCalls: contract.budget.maximumCombinedGatewayCalls,
  maxUsd: Number(contract.budget.maximumCombinedUsdDecimal), maxInputTokens: contract.budget.maximumInputTokens,
  maxOutputTokens: contract.budget.maximumOutputTokens,
  requestAllowance: { reservedUsd: 0.025, reservedInputTokens: 4_000, reservedOutputTokens: 500 } };
const gatewayBudgetPath = join(root, "gateway-requests.db");
let billingModule; let attestationModule; let codingWorktreeModule; let costModule; let loopModule;
let candidate; let control; let trustedPiEntry; let trustedExecutableFiles; let trustedRuntimeFiles;
let trustedRuntimeDigests; let assertFrozenRuntime;
try {
  mkdirSync(join(gitIsolationRoot, "hooks"), { recursive: true, mode: 0o700 });
  writeFileSync(join(gitIsolationRoot, "global.gitconfig"),
    `[core]\n\thooksPath = ${join(gitIsolationRoot, "hooks")}\n`, { encoding: "utf8", mode: 0o600 });
  installBenchmarkProcessIsolation(gitIsolationRoot, process.env);
  const trustedDistFiles = collectTrustedRuntimeFiles(join(repositoryRoot, "dist/main"), contract.trustedRuntimeModules);
  const trustedPackageFiles = collectTrustedPackageFiles(repositoryRoot, contract.trustedRuntimePackages);
  trustedPiEntry = join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(trustedPiEntry)) throw new Error("workspace-local trusted Pi executable unavailable");
  trustedExecutableFiles = collectTrustedExecutableFiles(trustedPiEntry);
  trustedRuntimeFiles = { ...trustedDistFiles, ...trustedPackageFiles, ...trustedExecutableFiles,
    ...Object.fromEntries(contract.trustedRuntimeArtifacts.map((path) => [path, join(repositoryRoot, path)])),
    "executable:pi": trustedPiEntry };
  trustedRuntimeDigests = captureTrustedRuntimeDigests(trustedRuntimeFiles);
  const trustedRuntimeClosureDigest = trustedRuntimeManifestDigest(trustedRuntimeDigests);
  if (Object.keys(trustedRuntimeFiles).length !== contract.trustedRuntimeClosure.fileCount
    || trustedRuntimeClosureDigest !== contract.trustedRuntimeClosure.manifestDigest) {
    throw new Error("built benchmark runtime does not match the frozen trusted closure");
  }
  assertFrozenRuntime = () => {
    assertTrustedRuntimeUnchanged(trustedRuntimeFiles, trustedRuntimeDigests);
    assertTrustedRuntimeFileSetUnchanged(trustedExecutableFiles, collectTrustedExecutableFiles(trustedPiEntry));
    assertTrustedGit();
  };
  billingModule = await import(pathToFileURL(join(repositoryRoot, "dist/main/adapters/naia-pi-versioned-billing.js")));
  attestationModule = await import(pathToFileURL(join(repositoryRoot, "dist/main/adapters/pi-cost-attestation.js")));
  costModule = await import(pathToFileURL(join(repositoryRoot, "dist/main/benchmark/pi-cost-comparison.js")));
  loopModule = await import(pathToFileURL(join(repositoryRoot, "dist/main/composition/pi-continuous-loop.js")));
  codingWorktreeModule = await import(pathToFileURL(join(repositoryRoot, "dist/main/adapters/coding-job-worktree.js")));
  billingModule.initializeGatewayRequestBudget(gatewayBudgetPath, gatewayBudgetPolicy);
  candidate = await runArm("candidate", contract.routePolicy.candidate);
  assertFrozenRuntime();
  persistPayload({ schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "running", completedArms: ["candidate"], completedActorAttempts: candidate.actorAttempts.length,
    gatewayCalls: candidate.calls.length, artifactRoot, candidate });
  control = await runArm("control", contract.routePolicy.control);
  assertFrozenRuntime();
  const finalLedger = billingModule.readGatewayRequestBudgetEvidence(gatewayBudgetPath, gatewayBudgetPolicy);
  const unsignedEvidence = { schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    taskDigest: contract.taskDigest, baselineDigest: contract.baselineDigest,
    minimumSavingsBasisPoints: contract.minimumSavingsBasisPoints, routePolicy: contract.routePolicy,
    expectedRoleCounts: contract.expectedRoleCounts,
    qualityPolicy: { scorerId: contract.quality.scorerId, requiredChecks: contract.quality.requiredChecks,
      allowedChangedFiles: contract.quality.allowedChangedFiles },
    budgetPolicy: contract.budget, priceVersionPolicy: contract.receiptAuthority.priceVersionByModel,
    executionAuthority: contract.executionAuthority,
    trustedRuntimeModules: Object.keys(trustedRuntimeFiles), trustedRuntimeDigests, trustedRuntimeClosureDigest,
    sharedGatewayLedger: { rows: finalLedger.rows,
      snapshot: { gatewayCalls: finalLedger.snapshot.gatewayCalls,
        activeReservations: finalLedger.snapshot.activeReservations,
        chargedUsdDecimal: finalLedger.snapshot.chargedUsdDecimal,
        chargedInputTokens: finalLedger.snapshot.chargedInputTokens,
        chargedOutputTokens: finalLedger.snapshot.chargedOutputTokens } },
    candidate, control };
  const authority = { integrityKey: journalKey, expectedKeyId: journalKeyId };
  const evidence = { ...unsignedEvidence, attestation: attestationModule.attestPiCostEvidence(unsignedEvidence, authority) };
  const result = costModule.analyzePiCostComparison(evidence, attestationModule.makePiCostAttestationVerifier(authority));
  const payload = { evidence, result };
  writePayload(payload);
  if (result.structuralOutcome === "invalid") process.exitCode = 2;
} catch (error) {
  let gatewayBudget;
  try { gatewayBudget = billingModule?.readGatewayRequestBudget(gatewayBudgetPath, gatewayBudgetPolicy); }
  catch { /* setup failed before a readable request ledger existed */ }
  writePayload({ schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "unavailable", completedActorAttempts: candidate?.actorAttempts.length ?? 0,
    gatewayCalls: gatewayBudget?.gatewayCalls ?? 0, ...(gatewayBudget ? { gatewayBudget } : {}), artifactRoot,
    reason: error instanceof Error ? error.message : String(error), costEfficiencyClaimAllowed: false,
    ...(candidate ? { candidate } : {}) });
  process.exitCode = 2;
}

async function runArm(name, policy) {
  const ledgerBefore = billingModule.readGatewayRequestBudgetEvidence(gatewayBudgetPath, gatewayBudgetPolicy);
  const armRoot = join(root, name); const source = join(armRoot, "source");
  mkdirSync(source, { recursive: true, mode: 0o700 }); cpSync(fixture, source, { recursive: true });
  git(source, ["init", "-b", "main"]); git(source, ["config", "user.email", "benchmark@nextain.invalid"]);
  git(source, ["config", "user.name", "Naia Benchmark"]); git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture baseline"], { GIT_AUTHOR_DATE: "2026-08-04T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-04T00:00:00Z" });
  const beforeCloseDigest = digestTree(source, true);
  const reopened = spawnSync(process.execPath,
    [join(repositoryRoot, "benchmark/digest-tree.mjs"), source, "--ignore-git"],
    { encoding: "utf8", env: withoutBenchmarkCredentials(process.env) });
  if (reopened.status !== 0) throw new Error(`${name} checkpoint reopen process failed: ${reopened.stderr || reopened.stdout}`);
  const afterOpenDigest = reopened.stdout.trim();
  if (beforeCloseDigest !== contract.baselineDigest || afterOpenDigest !== contract.baselineDigest) {
    throw new Error(`${name} checkpoint baseline mismatch before paid execution`);
  }
  const { makePiContinuousLoop } = loopModule;
  const { actorReceiptsToPiCostRows } = costModule;
  const worktrees = codingWorktreeModule.makeGitCodingJobWorktrees({ allowedWorkspaceRoot: source,
    worktreeRoot: join(armRoot, "worktrees"), git: (args, cwd) => { git(cwd, args); } });
  const verifier = { async verify(workdir) {
    const checks = [{ name: "file-content", pass: existsSync(join(workdir, "src/answer.js"))
      && readFileSync(join(workdir, "src/answer.js"), "utf8").trim() === "export const answer = 42;" },
    { name: "changed-files", pass: sameStrings(secureGitChangedFiles(workdir), contract.quality.allowedChangedFiles) }];
    return { ok: checks.every((check) => check.pass), checks };
  } };
  const binding = (role) => ({ provider: policy.provider, model: policy.roleModels[role] });
  const loop = makePiContinuousLoop({ stateDir: join(armRoot, "state"), workspaceRoot: source,
    worktreeRoot: join(armRoot, "worktrees"), facing: binding("facing"), moderator: binding("moderator"),
    reporter: binding("reporter"), roles: { explorer: binding("explorer"), implementer: binding("implementer"),
      tester: binding("tester"), reviewer: binding("reviewer") }, profileId: `${name}-pi`,
    maxRepairCycles: 1, requiredCleanCycles: 2,
    acceptanceChecks: [{ name: "file-content", command: process.execPath,
      args: ["-e", "const fs=require('node:fs');const s=fs.readFileSync('src/answer.js','utf8').trim();if(s!=='export const answer = 42;')process.exit(1)"] },
    { name: "changed-files", command: process.execPath,
      args: ["-e", "const{execFileSync}=require('node:child_process');const s=execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim();if(s!=='?? src/answer.js')process.exit(1)"] }],
    concurrency: 1,
    budget: { maxPaidCalls: 10, maxUsd: 0.25, maxInputTokens: 40_000, maxOutputTokens: 5_000 },
    callAllowance: { reservedUsd: 0.025, reservedInputTokens: 4_000, reservedOutputTokens: 500 },
    pi: { env: withoutBenchmarkIntegrityKey(process.env), piConfigDir: join(armRoot, "pi"),
      toolAllowlist: ["read", "write", "edit", "grep", "find", "ls"],
      beforeSpawn: assertFrozenRuntime,
      resolveBin: () => ({ command: process.execPath, prefixArgs: [trustedPiEntry] }),
      gatewayBudget: { path: gatewayBudgetPath, policy: gatewayBudgetPolicy } },
    diag: { log() {}, debug() {} } }, { worktrees, changedFiles: secureGitChangedFiles, verifier });
  try {
    const submitted = await loop.sessions.submit({ request: { requestId: `${contract.benchmarkId}:${name}`,
      text: contract.task.request, requiredObligations: contract.task.obligations, workspacePath: source,
      naiaBinding: binding("facing"), moderatorBinding: binding("moderator"),
      workerProfiles: { [`${name}-pi`]: loop.profile } },
    source: { kind: "local", sourceId: `${contract.benchmarkId}:${name}`, actorId: "benchmark" } });
    await loop.sessions.pump();
    const session = loop.sessions.get(submitted.sessionId);
    const issue = loop.issues.snapshot(submitted.issueId);
    if (!issue) throw new Error(`${name} issue snapshot unavailable`);
    const worktree = issue.worker?.worktreePath;
    const changedFiles = worktree ? [...secureGitChangedFiles(worktree)] : [];
    const checks = worktree ? [{ name: "file-content", pass: existsSync(join(worktree, "src/answer.js"))
      && readFileSync(join(worktree, "src/answer.js"), "utf8").trim() === "export const answer = 42;" },
    { name: "changed-files", pass: sameStrings(changedFiles, contract.quality.allowedChangedFiles) }]
      : contract.quality.requiredChecks.map((check) => ({ name: check, pass: false }));
    const rows = actorReceiptsToPiCostRows(issue.receipts);
    const sourceAudit = buildSourceAudit(issue.receipts, rows, armRoot, ledgerBefore);
    return { taskDigest: contract.taskDigest, status: session.state === "completed" ? "completed" : "failed",
      checkpoint: { beforeCloseDigest, afterOpenDigest }, scorerId: contract.quality.scorerId,
      checks, changedFiles, ...rows, sourceAudit, localBudget: { paidCalls: loop.budget.snapshot().paidCalls,
        activeReservations: loop.budget.snapshot().activeReservations } };
  } finally { loop.close(); }
}

function buildSourceAudit(actorReceipts, submittedRows, armRoot, ledgerBefore) {
  const receiptDir = join(armRoot, "pi", "receipts");
  const journalHeads = []; const journalReceipts = [];
  const files = existsSync(receiptDir) ? readdirSync(receiptDir).filter((name) => name.endsWith(".json")).sort() : [];
  for (const file of files) {
    const journal = billingModule.readNaiaPiReceiptJournal(join(receiptDir, file));
    const actor = actorReceipts.find((row) => row.executionId === journal.executionId);
    if (!actor) throw new Error(`receipt journal has no durable actor ${journal.executionId}`);
    journalHeads.push({ executionId: journal.executionId, headDigest: journal.headDigest,
      entryCount: journal.entries.length });
    const independentlyRead = actorReceiptsToRowsForJournal(actor, journal);
    for (let index = 0; index < independentlyRead.length; index += 1) {
      const entry = journal.entries[index]; const receipt = entry.receipt;
      journalReceipts.push({ ...independentlyRead[index], journalEntryDigest: entry.digest,
        ledgerReceiptDigest: billingModule.naiaPiGatewayReceiptDigest(receipt) });
    }
  }
  const ledgerAfter = billingModule.readGatewayRequestBudgetEvidence(gatewayBudgetPath, gatewayBudgetPolicy);
  const before = new Map(ledgerBefore.rows.map((row) => [row.requestId, row]));
  for (const row of ledgerAfter.rows) {
    const prior = before.get(row.requestId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("prior gateway ledger row changed during arm");
  }
  const gatewayLedger = ledgerAfter.rows.filter((row) => !before.has(row.requestId));
  const settled = gatewayLedger.filter((row) => row.status === "settled");
  const chargedUnits = settled.reduce((sum, row) => sum + moneyUnits8(row.actualCostDecimal), 0n);
  const sourceAudit = { journalHeads, journalReceipts, gatewayLedger,
    gatewayBudget: { gatewayCalls: gatewayLedger.length,
      activeReservations: gatewayLedger.filter((row) => row.status === "active").length,
      chargedUsdDecimal: moneyDecimal8(chargedUnits),
      chargedInputTokens: settled.reduce((sum, row) => sum + row.actualInputTokens, 0),
      chargedOutputTokens: settled.reduce((sum, row) => sum + row.actualOutputTokens, 0) } };
  const submitted = [...submittedRows.receipts].sort((left, right) => left.executionId.localeCompare(right.executionId));
  const preserved = journalReceipts.map(({ journalEntryDigest: _entry, ledgerReceiptDigest: _ledger, ...receipt }) => receipt)
    .sort((left, right) => left.executionId.localeCompare(right.executionId));
  if (JSON.stringify(submitted) !== JSON.stringify(preserved)) {
    throw new Error("submitted gateway receipts differ from preserved receipt journals");
  }
  return sourceAudit;
}

function actorReceiptsToRowsForJournal(actor, journal) {
  const role = actor.workerRole ?? (actor.role === "naia" ? "facing" : actor.role);
  return journal.entries.map(({ receipt: row }) => ({ executionId: row.localRequestId,
    actorExecutionId: actor.executionId, role, provider: actor.provider, model: actor.model,
    inputTokens: row.inputTokens + row.cachedInputTokens, outputTokens: row.outputTokens,
    gatewayRequestId: row.gatewayRequestId, priceVersionId: row.priceVersionId, source: row.source,
    settlementStatus: row.settlementStatus, customerCostDecimal: row.customerCostDecimal,
    customerCostUsd: row.customerCostUsd }));
}

function moneyUnits8(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(value)) {
    throw new Error("gateway ledger amount malformed");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}
function moneyDecimal8(units) {
  return `${units / 100_000_000n}.${String(units % 100_000_000n).padStart(8, "0")}`;
}

function git(cwd, args, extraEnv = {}) {
  assertTrustedGit();
  const invocation = makeBenchmarkGitInvocation(gitIsolationRoot, args, extraEnv,
    { ...process.env, PATH: dirname(trustedGitPath) });
  const run = spawnSync(trustedGitPath, invocation.args, { cwd, encoding: "utf8", env: invocation.env });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr || run.stdout}`);
  return run.stdout;
}
function secureGitChangedFiles(cwd) {
  return git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3)).sort();
}
function assertTrustedGit() {
  if (typeof trustedGitPath !== "string" || digestFile(trustedGitPath) !== trustedGitDigest) {
    throw new Error("trusted Git executable changed after pin validation");
  }
}
function digestFile(path) { return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; }
function digestTree(path, ignoreGit = false) {
  const files = walk(path).filter((file) => !(ignoreGit && relative(path, file).split(/[\\/]/u).includes(".git")));
  const hash = createHash("sha256");
  for (const file of files) { hash.update(relative(path, file).replaceAll("\\", "/")); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0"); }
  return `sha256:${hash.digest("hex")}`;
}
function walk(path) {
  return readdirSync(path).sort().flatMap((name) => { const child = join(path, name); return statSync(child).isDirectory() ? walk(child) : [child]; });
}
function sameStrings(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameJson(left, right) { return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right)); }
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, sortJson(value[key])]));
  return value;
}
function writePayload(payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  writeFileSync(1, serialized);
}
function printPayload(payload) { writeFileSync(1, `${JSON.stringify(payload, null, 2)}\n`); }
function claimOutput(payload) {
  if (!outputPath) throw new Error("durable output path unavailable");
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
function emitPreflight(payload) {
  if (!outputPath) { printPayload(payload); return; }
  try { claimOutput(payload); printPayload(payload); } catch { printPayload(payload); }
}
function persistPayload(payload) {
  if (!outputPath) throw new Error("durable output path unavailable");
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
