#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contract = JSON.parse(readFileSync(new URL("./orchestration/pi-cost-comparison.json", import.meta.url), "utf8"));
const fixture = fileURLToPath(new URL("./fixtures/pi-cost-comparison/base", import.meta.url));
const outputIndex = process.argv.indexOf("--output");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) throw new Error("--output requires a path");
const outputPath = outputArgument ? resolve(outputArgument) : undefined;
const artifactRoot = outputPath ? `${outputPath}.artifacts` : undefined;
const confirmed = process.argv.includes("--confirm-paid-comparison") && process.env.NAIA_PI_COST_CONFIRM === "1";
const key = (process.env.NAIA_API_KEY ?? process.env.NAIA_ANYLLM_API_KEY)?.trim();
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
const gatewayBudgetPolicy = { maxGatewayCalls: contract.budget.maximumCombinedGatewayCalls,
  maxUsd: contract.budget.maximumCombinedUsd, maxInputTokens: contract.budget.maximumInputTokens,
  maxOutputTokens: contract.budget.maximumOutputTokens,
  requestAllowance: { reservedUsd: 0.025, reservedInputTokens: 4_000, reservedOutputTokens: 500 } };
const gatewayBudgetPath = join(root, "gateway-requests.db");
let billingModule; let candidate; let control;
try {
  billingModule = await import(pathToFileURL(join(repositoryRoot, "dist/main/adapters/naia-pi-versioned-billing.js")));
  billingModule.initializeGatewayRequestBudget(gatewayBudgetPath, gatewayBudgetPolicy);
  candidate = await runArm("candidate", contract.routePolicy.candidate);
  persistPayload({ schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "running", completedArms: ["candidate"], completedActorAttempts: candidate.actorAttempts.length,
    gatewayCalls: candidate.calls.length, artifactRoot, candidate });
  control = await runArm("control", contract.routePolicy.control);
  const evidence = { schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    taskDigest: contract.taskDigest, baselineDigest: contract.baselineDigest,
    minimumSavingsRatio: contract.minimumSavingsRatio, routePolicy: contract.routePolicy,
    expectedRoleCounts: contract.expectedRoleCounts,
    qualityPolicy: { scorerId: contract.quality.scorerId, requiredChecks: contract.quality.requiredChecks,
      allowedChangedFiles: contract.quality.allowedChangedFiles },
    budgetPolicy: contract.budget, priceVersionPolicy: contract.receiptAuthority.priceVersionByModel,
    candidate, control };
  const { analyzePiCostComparison } = await import(pathToFileURL(join(repositoryRoot, "dist/main/benchmark/pi-cost-comparison.js")));
  const result = analyzePiCostComparison(evidence);
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
  const armRoot = join(root, name); const source = join(armRoot, "source");
  mkdirSync(source, { recursive: true, mode: 0o700 }); cpSync(fixture, source, { recursive: true });
  git(source, ["init", "-b", "main"]); git(source, ["config", "user.email", "benchmark@nextain.invalid"]);
  git(source, ["config", "user.name", "Naia Benchmark"]); git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture baseline"], { GIT_AUTHOR_DATE: "2026-08-04T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-04T00:00:00Z" });
  const beforeCloseDigest = digestTree(source, true);
  const reopened = spawnSync(process.execPath,
    [join(repositoryRoot, "benchmark/digest-tree.mjs"), source, "--ignore-git"], { encoding: "utf8" });
  if (reopened.status !== 0) throw new Error(`${name} checkpoint reopen process failed: ${reopened.stderr || reopened.stdout}`);
  const afterOpenDigest = reopened.stdout.trim();
  if (beforeCloseDigest !== contract.baselineDigest || afterOpenDigest !== contract.baselineDigest) {
    throw new Error(`${name} checkpoint baseline mismatch before paid execution`);
  }
  const dist = join(repositoryRoot, "dist/main");
  const { makePiContinuousLoop } = await import(pathToFileURL(join(dist, "composition/pi-continuous-loop.js")));
  const { actorReceiptsToPiCostRows } = await import(pathToFileURL(join(dist, "benchmark/pi-cost-comparison.js")));
  const { gitChangedFiles } = await import(pathToFileURL(join(dist, "composition/supervised-issue-worker.js")));
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
    pi: { env: process.env, piConfigDir: join(armRoot, "pi"),
      gatewayBudget: { path: gatewayBudgetPath, policy: gatewayBudgetPolicy } },
    diag: { log() {}, debug() {} } });
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
    const changedFiles = worktree ? [...gitChangedFiles(worktree)] : [];
    const checks = worktree ? [{ name: "file-content", pass: existsSync(join(worktree, "src/answer.js"))
      && readFileSync(join(worktree, "src/answer.js"), "utf8").trim() === "export const answer = 42;" },
    { name: "changed-files", pass: sameStrings(changedFiles, contract.quality.allowedChangedFiles) }]
      : contract.quality.requiredChecks.map((check) => ({ name: check, pass: false }));
    const rows = actorReceiptsToPiCostRows(issue.receipts);
    return { taskDigest: contract.taskDigest, status: session.state === "completed" ? "completed" : "failed",
      checkpoint: { beforeCloseDigest, afterOpenDigest }, scorerId: contract.quality.scorerId,
      checks, changedFiles, ...rows, localBudget: { paidCalls: loop.budget.snapshot().paidCalls,
        activeReservations: loop.budget.snapshot().activeReservations } };
  } finally { loop.close(); }
}

function git(cwd, args, extraEnv = {}) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr || run.stdout}`);
}
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
