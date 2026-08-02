#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const corpusPath = fileURLToPath(new URL("./orchestration/issue-team-deterministic.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
if (corpus.paidCalls !== 0) throw new Error("deterministic benchmark must make zero paid calls");
const sourceIndex = process.argv.indexOf("--source-revision");
const sourceRevision = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/u.test(sourceRevision ?? "")) throw new Error("source revision must be a full commit hash");
const trackedInputs = ["benchmark/run-issue-team-deterministic.mjs", "benchmark/orchestration/issue-team-deterministic.json",
  "src/main/app/issue-team-worker.ts", "src/main/adapters/sqlite-issue-team-store.ts", "src/main/domain/issue-team.ts",
  "src/main/domain/issue-team-benchmark.ts", "src/main/ports/issue-team.ts", "package.json", "pnpm-lock.yaml", "tsconfig.json"];
execFileSync("git", ["merge-base", "--is-ancestor", sourceRevision, "HEAD"], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--quiet", sourceRevision, "HEAD", "--", ...trackedInputs], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--quiet", "--", ...trackedInputs], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--cached", "--quiet", "--", ...trackedInputs], { cwd: repositoryRoot });
const distIndex = process.argv.indexOf("--dist-dir");
const distRoot = distIndex >= 0 ? resolve(process.argv[distIndex + 1] ?? "") : join(repositoryRoot, "dist");
const { makeIssueTeamWorker } = await import(pathToFileURL(join(distRoot, "main/app/issue-team-worker.js")));
const { SqliteIssueTeamStore } = await import(pathToFileURL(join(distRoot, "main/adapters/sqlite-issue-team-store.js")));
const { evaluateIssueTeamBenchmark } = await import(pathToFileURL(join(distRoot, "main/domain/issue-team-benchmark.js")));
const root = mkdtempSync(join(tmpdir(), "naia-issue-team-benchmark-"));
const profile = { kind: "team", maxRepairCycles: 2, requiredCleanCycles: 2, roles: Object.fromEntries(
  ["explorer", "implementer", "tester", "reviewer"].map((role) => [role, { agentProfileId: `${role}-profile`,
    agentKind: role === "implementer" ? "opencode" : role === "tester" ? "pi" : "codex",
    binding: { provider: `${role}-provider`, model: `${role}-model` }, filesystemAccess: role === "implementer" ? "workspace_write" : "read_only" }])) };
const input = { issueId: "benchmark-issue", dispatchId: "benchmark-issue:dispatch:1", workspacePath: "/benchmark/repo", task: "fix parser",
  obligations: ["fix parser"], profileId: "benchmark-team", profile, acceptanceChecks: ["tests pass"], signal: new AbortController().signal };
let effects = 0; const seen = [];
const store = new SqliteIssueTeamStore(join(root, "team.db"));
const worker = makeIssueTeamWorker({ store, worktrees: fixtureWorktrees(), changedFiles: () => ["src/parser.ts"], roles: { async execute(value) {
  const role = corpus.expectedOrder[effects]; const decision = corpus.decisions[effects]; effects += 1;
  seen.push({ role, access: value.roleProfile.filesystemAccess });
  return { result: { version: 1, role, decision, summary: `${role}:${decision}`, findings: decision === "fail" ? [{ code: "T1", message: "repair" }] : [] },
    receipt: receipt(role, value.stepId, effects) };
} } });

try {
  const completed = await worker.execute(input); const effectsAfterFirst = effects; await worker.execute(input);
  const recoveryStore = new SqliteIssueTeamStore(join(root, "recovery.db")); let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const interruptedWorker = makeIssueTeamWorker({ store: recoveryStore, worktrees: fixtureWorktrees(), roles: { async execute() { await gate; throw new Error("interrupted fixture"); } } });
  const interrupted = interruptedWorker.execute({ ...input, dispatchId: "benchmark-recovery:dispatch:1" }).catch(() => undefined);
  await until(() => recoveryStore.get("benchmark-recovery:dispatch:1")?.state === "running");
  const unknownInflightRecovery = await interruptedWorker.recover?.({ ...input, dispatchId: "benchmark-recovery:dispatch:1" }) === undefined;
  release(); await interrupted;
  const receipts = completed.receipts ?? [];
  const expectedCostUsd = receipts.length * corpus.costPerAttemptUsd;
  const observedCostUsd = receipts.reduce((sum, item) => sum + (item.cost.state === "measured" ? item.cost.usd : 0), 0);
  const observation = { roleOrderMatches: JSON.stringify(seen.map((item) => item.role)) === JSON.stringify(corpus.expectedOrder),
    writeBoundaryViolations: seen.filter((item) => (item.role === "implementer") !== (item.access === "workspace_write")).length,
    repairCycles: completed.team?.repairCycles ?? -1, cleanCycles: completed.team?.cleanCycles ?? -1,
    duplicateRoleEffects: effects - effectsAfterFirst, unknownInflightRecovery, receiptCount: receipts.length,
    distinctReceiptIdentities: new Set(receipts.flatMap((item) => [item.sessionId, item.executionId])).size / 2,
    allCostsMeasured: receipts.every((item) => item.cost.state === "measured"), expectedCostUsd, observedCostUsd };
  const evaluation = evaluateIssueTeamBenchmark(observation);
  const runtimeModules = ["main/app/issue-team-worker.js", "main/adapters/sqlite-issue-team-store.js", "main/domain/issue-team-benchmark.js"];
  const output = { schemaVersion: corpus.schemaVersion, benchmarkId: corpus.benchmarkId, sourceRevision, paidCalls: 0, observation,
    evidence: { trackedInputs: Object.fromEntries(trackedInputs.map((path) => [path, sha256(join(repositoryRoot, path))])),
      runtimeModules: Object.fromEntries(runtimeModules.map((path) => [`dist/${path}`, sha256(join(distRoot, path))])) }, ...evaluation };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) { const path = process.argv[outputIndex + 1]; if (!path) throw new Error("--output requires a path"); writeFileSync(path, serialized, { mode: 0o600 }); try { chmodSync(path, 0o600); } catch {} }
  process.stdout.write(serialized); if (!evaluation.claimAllowed) process.exitCode = 1;
  recoveryStore.close();
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }

function fixtureWorktrees() { return { allocate() { return { workspacePath: "/benchmark/repo", worktreePath: "/benchmark/worktree", branch: "naia/benchmark", leaseId: "lease", release() {} }; }, recover() { return true; } }; }
function receipt(role, key, n) { const declared = profile.roles[role]; return { role: "worker", workerRole: role, agentProfileId: declared.agentProfileId, agentKind: declared.agentKind,
  provider: declared.binding.provider, model: declared.binding.model, sessionId: `session-${n}`, executionId: `execution-${n}`, idempotencyKey: key,
  tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, latencyMs: 1, cost: { state: "measured", usd: corpus.costPerAttemptUsd, source: "fixture" } }; }
async function until(predicate) { for (let i = 0; i < 200; i += 1) { if (predicate()) return; await new Promise((resolveWait) => setTimeout(resolveWait, 1)); } throw new Error("benchmark timed out"); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
