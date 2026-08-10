#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const corpusPath = fileURLToPath(new URL("./orchestration/multi-issue-deterministic.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
if (corpus.paidCalls !== 0) throw new Error("deterministic benchmark must make zero paid calls");
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceArgument = process.argv.indexOf("--source-revision");
const sourceRevision = sourceArgument >= 0 ? process.argv[sourceArgument + 1] : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repositoryRoot }).trim();
if (!sourceRevision || !/^[0-9a-f]{40}$/u.test(sourceRevision)) throw new Error("source revision must be a full commit hash");
execFileSync("git", ["merge-base", "--is-ancestor", sourceRevision, "HEAD"], { cwd: repositoryRoot });
const trackedInputs = [
  "benchmark/run-multi-issue-deterministic.mjs",
  "benchmark/orchestration/multi-issue-deterministic.json",
  "src/main/adapters/sqlite-multi-issue-session-store.ts",
  "src/main/adapters/redact.ts",
  "src/main/app/multi-issue-session-manager.ts",
  "src/main/domain/multi-issue-benchmark.ts",
  "src/main/domain/multi-issue-session.ts",
  "src/main/ports/multi-issue-session.ts",
  "package.json", "pnpm-lock.yaml", "tsconfig.json"
];
execFileSync("git", ["diff", "--quiet", sourceRevision, "HEAD", "--", ...trackedInputs], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--quiet", "--", ...trackedInputs], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--cached", "--quiet", "--", ...trackedInputs], { cwd: repositoryRoot });
const distArgument = process.argv.indexOf("--dist-dir");
const distRoot = distArgument >= 0 ? resolve(process.argv[distArgument + 1] ?? "") : join(repositoryRoot, "dist");
const runtimeModules = [
  "main/adapters/sqlite-multi-issue-session-store.js",
  "main/adapters/redact.js",
  "main/app/multi-issue-session-manager.js",
  "main/domain/multi-issue-benchmark.js",
  "main/domain/multi-issue-session.js"
];
const { SqliteMultiIssueSessionStore } = await import(pathToFileURL(join(distRoot, "main/adapters/sqlite-multi-issue-session-store.js")));
const { MultiIssueSessionManager } = await import(pathToFileURL(join(distRoot, "main/app/multi-issue-session-manager.js")));
const { evaluateMultiIssueBenchmark } = await import(pathToFileURL(join(distRoot, "main/domain/multi-issue-benchmark.js")));
const root = mkdtempSync(join(tmpdir(), "naia-multi-benchmark-"));

class DeterministicIssues {
  snapshots = new Map();
  starts = [];
  effects = new Set();
  effectApplications = 0;
  active = 0;
  maximumActive = 0;
  gates = new Map();
  costs = new Map();

  ensure(request) {
    const issueId = `issue-${request.requestId}`;
    const prior = this.snapshots.get(issueId);
    if (prior) return prior;
    const snapshot = {
      version: 1, requestId: request.requestId,
      requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), issueId,
      originalText: request.text, requiredObligations: request.requiredObligations,
      workspacePath: request.workspacePath, state: "accepted", naiaBinding: request.naiaBinding,
      moderatorBinding: request.moderatorBinding, workerProfiles: request.workerProfiles,
      answers: [], receipts: [], createdAt: "2026-08-02T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z",
    };
    this.snapshots.set(issueId, snapshot);
    return snapshot;
  }
  async resume(issueId) {
    this.starts.push(issueId);
    if (!this.effects.has(issueId)) { this.effects.add(issueId); this.effectApplications += 1; }
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      const gate = this.gates.get(issueId);
      if (gate) await gate.promise;
      else await new Promise((resolve) => setImmediate(resolve));
      return completed(issueId, this.costs.get(issueId) ?? 0.1);
    } finally { this.active -= 1; }
  }
  async answer(issueId) { return completed(issueId, this.costs.get(issueId) ?? 0.1); }
  async cancel(issueId) { return { ...completed(issueId, 0), state: "cancelled", verificationPassed: null }; }
  snapshot(issueId) { return this.snapshots.get(issueId); }
  defer(issueId) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    this.gates.set(issueId, { promise, resolve });
  }
}

function completed(issueId, usd) {
  return { state: "completed", summary: "fixture complete", issueId, changedFiles: [], verificationPassed: true,
    totalCost: { state: "measured", usd, source: "deterministic_fixture" } };
}
function request(id) {
  return {
    requestId: id.replace(/^issue-/u, ""), text: `Implement ${id}`, requiredObligations: [`finish ${id}`], workspacePath: `/work/${id}`,
    naiaBinding: { provider: "fixture", model: "luna-proxy" }, moderatorBinding: { provider: "fixture", model: "sol-moderator" },
    workerProfiles: { balanced: { provider: "fixture", model: "codex-worker" } },
  };
}
function submission(item) {
  return { request: request(item.id), source: { kind: "local", sourceId: `benchmark-${item.id}`, actorId: "benchmark" }, reservationUsd: item.reservationUsd };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("benchmark condition timed out");
}

try {
  const issues = new DeterministicIssues();
  for (const item of corpus.cases) issues.costs.set(item.id, item.costUsd);
  const store = new SqliteMultiIssueSessionStore(join(root, "main.db"));
  let sequence = 0;
  const manager = new MultiIssueSessionManager({
    store, issues, concurrency: corpus.concurrency, aggregateThresholdUsd: corpus.aggregateThresholdUsd,
    autoPump: false, ids: () => `session-${++sequence}`, ownerIds: () => "benchmark-owner",
    now: () => "2026-08-02T00:00:00Z",
  });
  for (const item of corpus.cases) await manager.submit(submission(item));
  await manager.pump();
  const portfolio = manager.portfolio();

  const restartIssues = new DeterministicIssues();
  restartIssues.defer(corpus.restartCase.id);
  const restartPath = join(root, "restart.db");
  const beforeStore = new SqliteMultiIssueSessionStore(restartPath);
  const afterStore = new SqliteMultiIssueSessionStore(restartPath);
  let nowMs = 1_000;
  const common = { issues: restartIssues, concurrency: 1, autoPump: false, schedulerLeaseMs: corpus.restartCase.leaseMs,
    clockMs: () => nowMs, now: () => "2026-08-02T00:00:01Z" };
  const before = new MultiIssueSessionManager({ ...common, store: beforeStore, ids: () => "restart-session", ownerIds: () => "before" });
  const after = new MultiIssueSessionManager({ ...common, store: afterStore, ids: () => "unused", ownerIds: () => "after" });
  await before.submit(submission({ ...corpus.restartCase, reservationUsd: 0.1 }));
  const interrupted = before.pump();
  await until(() => restartIssues.starts.length === 1);
  nowMs += corpus.restartCase.leaseMs;
  const recovered = after.pump();
  await until(() => restartIssues.starts.length === 2);
  restartIssues.gates.get(corpus.restartCase.id).resolve();
  await Promise.all([interrupted, recovered]);
  const recoveredSession = after.get("restart-session");

  const terminal = portfolio.sessions.filter((session) => ["chat", "completed", "failed", "cancelled", "outcome_unknown"].includes(session.state)).length;
  const expectedCostUsd = corpus.cases.reduce((sum, item) => sum + item.costUsd, 0);
  const observation = {
    submitted: corpus.cases.length,
    terminal,
    identityLeakCount: portfolio.sessions.filter((session) => session.issueId !== `issue-${session.requestId}` || session.report?.issueId !== session.issueId).length,
    expectedStartOrder: corpus.expectedStartOrder,
    observedStartOrder: issues.starts,
    configuredConcurrency: corpus.concurrency,
    maximumObservedConcurrency: issues.maximumActive,
    restartDuplicateEffects: Math.max(0, restartIssues.effectApplications - 1),
    visibilityCountMatches: Object.values(portfolio.counts).reduce((sum, count) => sum + count, 0) === corpus.cases.length
      && recoveredSession.state === "completed",
    allCostsMeasured: portfolio.totalCost.state === "measured",
    expectedCostUsd,
    observedCostUsd: portfolio.totalCost.state === "measured" ? portfolio.totalCost.usd : Number.NaN,
  };
  const evaluation = evaluateMultiIssueBenchmark(observation);
  const result = { schemaVersion: corpus.schemaVersion, benchmarkId: corpus.benchmarkId, sourceRevision, paidCalls: 0, observation,
    evidence: { sessionStates: portfolio.sessions.map(({ sessionId, issueId, state }) => ({ sessionId, issueId, state })),
      restart: { starts: restartIssues.starts, effectApplications: restartIssues.effectApplications, finalState: recoveredSession.state },
      provenance: {
        trackedInputs: Object.fromEntries(trackedInputs.map((path) => [path, sha256(join(repositoryRoot, path))])),
        runtimeModules: Object.fromEntries(runtimeModules.map((path) => [`dist/${path}`, sha256(join(distRoot, path))]))
      } },
    ...evaluation };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new Error("--output requires a path");
    writeFileSync(output, serialized, { mode: 0o600 });
    try { chmodSync(output, 0o600); } catch { /* Windows. */ }
  }
  process.stdout.write(serialized);
  if (!evaluation.claimAllowed) process.exitCode = 1;
  store.close(); beforeStore.close(); afterStore.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

function sha256(path) { return createHash("sha256").update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex"); }
