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
  "src/main/app/issue-team-worker.ts", "src/main/adapters/sqlite-issue-team-store.ts", "src/main/adapters/subagent-pi.ts",
  "src/main/adapters/subagent-opencode-cli.ts", "src/main/adapters/subagent-codex.ts", "src/main/domain/issue-team.ts",
  "src/main/domain/issue-team-benchmark.ts", "src/main/ports/issue-team.ts", "src/main/composition/supervised-issue-worker.ts",
  "src/main/composition/issue-team-role-executor.ts", "src/main/app/single-issue-orchestrator.ts",
  "src/main/composition/profiled-issue-worker.ts",
  "src/main/adapters/sqlite-issue-orchestration-store.ts", "src/main/domain/issue-orchestration.ts", "src/main/ports/issue-orchestration.ts",
  "package.json", "pnpm-lock.yaml", "tsconfig.json"];
execFileSync("git", ["merge-base", "--is-ancestor", sourceRevision, "HEAD"], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--quiet", sourceRevision, "HEAD", "--", ...trackedInputs], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--quiet", "--", ...trackedInputs], { cwd: repositoryRoot });
execFileSync("git", ["diff", "--cached", "--quiet", "--", ...trackedInputs], { cwd: repositoryRoot });
const distIndex = process.argv.indexOf("--dist-dir");
const distRoot = distIndex >= 0 ? resolve(process.argv[distIndex + 1] ?? "") : join(repositoryRoot, "dist");
const { makeIssueTeamWorker } = await import(pathToFileURL(join(distRoot, "main/app/issue-team-worker.js")));
const { SqliteIssueTeamStore } = await import(pathToFileURL(join(distRoot, "main/adapters/sqlite-issue-team-store.js")));
const { evaluateIssueTeamBenchmark } = await import(pathToFileURL(join(distRoot, "main/domain/issue-team-benchmark.js")));
const { makeSupervisedIssueWorker } = await import(pathToFileURL(join(distRoot, "main/composition/supervised-issue-worker.js")));
const { makePiSubAgent } = await import(pathToFileURL(join(distRoot, "main/adapters/subagent-pi.js")));
const { makeOpencodeSubAgent } = await import(pathToFileURL(join(distRoot, "main/adapters/subagent-opencode-cli.js")));
const { makeCodexSubAgent } = await import(pathToFileURL(join(distRoot, "main/adapters/subagent-codex.js")));
const { makeIssueTeamRoleExecutor } = await import(pathToFileURL(join(distRoot, "main/composition/issue-team-role-executor.js")));
const { SingleIssueOrchestrator } = await import(pathToFileURL(join(distRoot, "main/app/single-issue-orchestrator.js")));
const { SqliteIssueOrchestrationStore } = await import(pathToFileURL(join(distRoot, "main/adapters/sqlite-issue-orchestration-store.js")));
const { makeIssueWorkerRouter } = await import(pathToFileURL(join(distRoot, "main/composition/profiled-issue-worker.js")));
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
  const legacyBinding = { provider: "legacy-provider", model: "legacy-model" };
  const legacyWorker = makeSupervisedIssueWorker({ worktrees: fixtureWorktrees(), diag: { log() {}, debug() {} }, changedFiles: () => [],
    subAgent: { spawn() { return { async cancel() {}, events: (async function* () { yield { kind: "session_end", ok: true, evidence: {
      provider: legacyBinding.provider, selectedModel: legacyBinding.model, modelEvidenceSource: "adapter_requested",
      inputTokens: 1, outputTokens: 1, totalTokens: 2, usageAvailable: true, measuredCostUsd: 0.001,
      sessionId: "legacy-session", executionId: "legacy-execution" } }; })() }; } } });
  const legacy = await legacyWorker.execute({ issueId: "legacy-issue", dispatchId: "legacy-issue:dispatch:1", workspacePath: "/benchmark/repo",
    task: "legacy", obligations: ["legacy"], profileId: "legacy", profile: legacyBinding, binding: legacyBinding,
    acceptanceChecks: ["legacy check"], signal: new AbortController().signal });
  const legacyProfilePreserved = legacy.ok && legacy.receipt.idempotencyKey === "legacy-issue:dispatch:1" && legacy.receipts === undefined;
  const recoveryStore = new SqliteIssueTeamStore(join(root, "recovery.db")); let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const interruptedWorker = makeIssueTeamWorker({ store: recoveryStore, worktrees: fixtureWorktrees(), roles: { async execute() { await gate; throw new Error("interrupted fixture"); } } });
  const interrupted = interruptedWorker.execute({ ...input, dispatchId: "benchmark-recovery:dispatch:1" }).catch(() => undefined);
  await until(() => recoveryStore.get("benchmark-recovery:dispatch:1")?.state === "running");
  const unknownInflightRecovery = await interruptedWorker.recover?.({ ...input, dispatchId: "benchmark-recovery:dispatch:1" }) === undefined;
  release(); await interrupted;
  const readyRecoveryStore = new SqliteIssueTeamStore(join(root, "ready-recovery.db"));
  const crashAfterReady = { createOrGet: (snapshot) => readyRecoveryStore.createOrGet(snapshot), get: (id) => readyRecoveryStore.get(id),
    save(value) { const saved = readyRecoveryStore.save(value); if (value.eventType === "role_acknowledged") throw new Error("simulated restart"); return saved; }, close() {} };
  const readyInput = { ...input, dispatchId: "benchmark-ready-recovery:dispatch:1" };
  const crashWorker = makeIssueTeamWorker({ store: crashAfterReady, worktrees: fixtureWorktrees(), roles: { async execute(value) {
    return { result: { version: 1, role: "explorer", decision: "proceed", summary: "ready", findings: [] }, receipt: receipt("explorer", value.stepId, 101) };
  } } });
  await crashWorker.execute(readyInput).catch(() => undefined);
  let resumedRoleCalls = 0;
  const failedRecoveryWorker = makeIssueTeamWorker({ store: readyRecoveryStore,
    worktrees: { ...fixtureWorktrees(), recover() { return false; } }, roles: { async execute() { resumedRoleCalls += 1; throw new Error("unexpected dispatch"); } } });
  const failedReadyRecovery = await failedRecoveryWorker.recover?.(readyInput) === undefined && resumedRoleCalls === 0;
  const rejectedStore = new SqliteIssueTeamStore(join(root, "rejected-recovery.db"));
  const rejectedInput = { ...input, dispatchId: "benchmark-rejected-recovery:dispatch:1" };
  const rejectedWorker = makeIssueTeamWorker({ store: rejectedStore, worktrees: fixtureWorktrees(), roles: { async execute(value) {
    return { result: { version: 1, role: "explorer", decision: "proceed", summary: "bad", findings: [{ code: 7, message: "numeric" }] },
      receipt: receipt("explorer", value.stepId, 102) };
  } } });
  await rejectedWorker.execute(rejectedInput).catch(() => undefined);
  const recoveredFailure = await rejectedWorker.recover?.(rejectedInput).catch((error) => error);
  const rejectedFailureRecovered = recoveredFailure?.receipts?.length === 1 && recoveredFailure.receipt?.workerRole === "explorer";
  const adapterReadOnlyEnforced = await observeAdapterReadOnlyBoundary(makePiSubAgent, makeOpencodeSubAgent, makeCodexSubAgent);
  const roleExecutorBoundaryPreserved = await observeRoleExecutorBoundary(makeIssueTeamRoleExecutor);
  const parentProjectionValidated = await observeParentProjectionBoundary(SingleIssueOrchestrator, SqliteIssueOrchestrationStore, join(root, "parent.db"));
  const productionRouterWired = await observeProductionRouter(makeIssueWorkerRouter);
  const receipts = completed.receipts ?? [];
  const expectedCostUsd = receipts.length * corpus.costPerAttemptUsd;
  const observedCostUsd = receipts.reduce((sum, item) => sum + (item.cost.state === "measured" ? item.cost.usd : 0), 0);
  const observation = { roleOrderMatches: JSON.stringify(seen.map((item) => item.role)) === JSON.stringify(corpus.expectedOrder),
    writeBoundaryViolations: seen.filter((item) => (item.role === "implementer") !== (item.access === "workspace_write")).length,
    adapterReadOnlyEnforced, roleExecutorBoundaryPreserved, parentProjectionValidated, productionRouterWired,
    repairCycles: completed.team?.repairCycles ?? -1, cleanCycles: completed.team?.cleanCycles ?? -1,
    duplicateRoleEffects: effects - effectsAfterFirst, unknownInflightRecovery: unknownInflightRecovery && failedReadyRecovery,
    rejectedFailureRecovered, legacyProfilePreserved, receiptCount: receipts.length,
    distinctReceiptIdentities: new Set(receipts.flatMap((item) => [item.sessionId, item.executionId])).size / 2,
    allCostsMeasured: receipts.every((item) => item.cost.state === "measured"), expectedCostUsd, observedCostUsd };
  const evaluation = evaluateIssueTeamBenchmark(observation);
  const runtimeModules = ["main/app/issue-team-worker.js", "main/adapters/sqlite-issue-team-store.js", "main/adapters/subagent-pi.js",
    "main/adapters/subagent-opencode-cli.js", "main/adapters/subagent-codex.js", "main/domain/issue-team-benchmark.js",
    "main/composition/supervised-issue-worker.js", "main/composition/issue-team-role-executor.js", "main/app/single-issue-orchestrator.js",
    "main/adapters/sqlite-issue-orchestration-store.js", "main/composition/profiled-issue-worker.js"];
  const output = { schemaVersion: corpus.schemaVersion, benchmarkId: corpus.benchmarkId, sourceRevision, paidCalls: 0, observation,
    evidence: { trackedInputs: Object.fromEntries(trackedInputs.map((path) => [path, sha256(join(repositoryRoot, path))])),
      runtimeModules: Object.fromEntries(runtimeModules.map((path) => [`dist/${path}`, sha256(join(distRoot, path))])) }, ...evaluation };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) { const path = process.argv[outputIndex + 1]; if (!path) throw new Error("--output requires a path"); writeFileSync(path, serialized, { mode: 0o600 }); try { chmodSync(path, 0o600); } catch {} }
  process.stdout.write(serialized); if (!evaluation.claimAllowed) process.exitCode = 1;
  recoveryStore.close(); readyRecoveryStore.close(); rejectedStore.close();
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }

function fixtureWorktrees() { return { allocate() { return { workspacePath: "/benchmark/repo", worktreePath: "/benchmark/worktree", branch: "naia/benchmark", leaseId: "lease", release() {} }; }, recover() { return true; } }; }
function receipt(role, key, n) { const declared = profile.roles[role]; return { role: "worker", workerRole: role, agentProfileId: declared.agentProfileId, agentKind: declared.agentKind,
  provider: declared.binding.provider, model: declared.binding.model, sessionId: `session-${n}`, executionId: `execution-${n}`, idempotencyKey: key,
  tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, latencyMs: 1, cost: { state: "measured", usd: corpus.costPerAttemptUsd, source: "fixture" } }; }
async function until(predicate) { for (let i = 0; i < 200; i += 1) { if (predicate()) return; await new Promise((resolveWait) => setTimeout(resolveWait, 1)); } throw new Error("benchmark timed out"); }
async function observeAdapterReadOnlyBoundary(makePi, makeOpencode, makeCodex) {
  const piCapture = captureSpawn();
  makePi({ resolveBin: () => ({ command: "pi", prefixArgs: [] }), spawnFn: piCapture.spawnFn })
    .spawn({ prompt: "inspect", workdir: "/benchmark/worktree", filesystemAccess: "read_only" });
  const piArgs = piCapture.args ?? [];
  const opencodeCapture = captureSpawn();
  const opencodeSession = makeOpencode({ resolveBin: () => ({ command: "opencode", prefixArgs: [] }), spawnFn: opencodeCapture.spawnFn })
    .spawn({ prompt: "inspect", workdir: "/benchmark/worktree", filesystemAccess: "read_only" });
  let failedClosed = false;
  for await (const event of opencodeSession.events) if (event.kind === "session_end") failedClosed = event.ok === false;
  const codexCapture = captureSpawn();
  makeCodex({ resolveBin: () => ({ command: "codex", prefixArgs: [] }), spawnFn: codexCapture.spawnFn })
    .spawn({ prompt: "inspect", workdir: "/benchmark/worktree", filesystemAccess: "read_only" });
  const sandboxIndex = (codexCapture.args ?? []).indexOf("--sandbox");
  return piArgs.includes("--tools") && piArgs.includes("read,grep,find,ls") && opencodeCapture.calls === 0 && failedClosed
    && sandboxIndex >= 0 && codexCapture.args?.[sandboxIndex + 1] === "read-only";
}
async function observeRoleExecutorBoundary(makeExecutor) {
  let captured;
  const declared = profile.roles.explorer;
  const executor = makeExecutor({ diag: { log() {}, debug() {} }, agents: { [declared.agentProfileId]: { agentKind: "codex", adapter: { spawn(task) {
    captured = task; return { async cancel() {}, events: (async function* () {
      yield { kind: "text_delta", text: JSON.stringify({ version: 1, role: "explorer", decision: "proceed", summary: "ok", findings: [] }) };
      yield { kind: "session_end", ok: true, evidence: { provider: declared.binding.provider, selectedModel: declared.binding.model,
        modelEvidenceSource: "adapter_requested", inputTokens: 0, outputTokens: 0, totalTokens: 0, usageAvailable: false,
        sessionId: "executor-session", executionId: "executor-execution" } };
    })() }; } } } } });
  await executor.execute({ issueId: "executor-issue", dispatchId: "executor-dispatch", stepId: "executor-dispatch:explorer:1",
    worktreePath: "/benchmark/worktree", task: "inspect", context: "{}", roleProfile: declared, signal: new AbortController().signal });
  return captured?.filesystemAccess === "read_only" && captured?.workdir === "/benchmark/worktree";
}
async function observeParentProjectionBoundary(Orchestrator, Store, path) {
  const parentStore = new Store(path); let n = 0;
  const actor = (role, key, provider, model) => ({ role, provider, model, sessionId: `parent-session-${++n}`, executionId: `parent-execution-${n}`,
    idempotencyKey: key, tokenCountsAvailable: true, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, latencyMs: 1,
    cost: { state: "measured", usd: 0.001, source: "fixture" } });
  const workerReceipts = ["explorer", "implementer", "tester", "reviewer"].map((role, index) => { const declared = profile.roles[role];
    return { ...actor("worker", `parent-issue:dispatch:1:${role}:${index + 1}`, declared.binding.provider, declared.binding.model),
      workerRole: role, agentProfileId: declared.agentProfileId, agentKind: declared.agentKind }; });
  const orchestrator = new Orchestrator({ store: parentStore, ids: () => "parent-issue", now: () => "2026-08-02T00:00:00Z",
    facing: { async classify(value) { return { classification: { kind: "work", obligations: value.requiredObligations }, receipt: actor("naia", value.idempotencyKey, "naia", "luna") }; } },
    moderator: { async plan(value) { return { plan: { workerTask: "fix", workerProfile: "benchmark-team", acceptanceChecks: ["check"], questions: [] }, receipt: actor("moderator", value.idempotencyKey, "codex", "sol") }; } },
    worker: { async execute() { return { ok: true, summary: "missing projection", worktreePath: "/benchmark/worktree", changedFiles: [], receipt: workerReceipts[1], receipts: workerReceipts }; } },
    verifier: { async verify() { throw new Error("unexpected verifier"); } }, reporter: { async report() { throw new Error("unexpected reporter"); } } });
  const report = await orchestrator.start({ requestId: "parent-request", text: "fix", requiredObligations: ["fix"], workspacePath: "/benchmark/repo",
    naiaBinding: { provider: "naia", model: "luna" }, moderatorBinding: { provider: "codex", model: "sol" }, workerProfiles: { "benchmark-team": profile } });
  parentStore.close(); return report.state === "outcome_unknown";
}
async function observeProductionRouter(makeRouter) {
  let legacyCalls = 0; let teamCalls = 0;
  const legacyResult = { route: "legacy" }; const teamResult = { route: "team" };
  const router = makeRouter({ legacy: { async execute() { legacyCalls += 1; return legacyResult; } },
    team: { async execute() { teamCalls += 1; return teamResult; } } });
  const legacy = await router.execute({ ...input, profile: { provider: "legacy", model: "legacy" }, binding: { provider: "legacy", model: "legacy" } });
  const selectedTeam = await router.execute(input);
  return legacy === legacyResult && selectedTeam === teamResult && legacyCalls === 1 && teamCalls === 1;
}
function captureSpawn() {
  const capture = { calls: 0, args: undefined, spawnFn(command, args) { capture.calls += 1; capture.args = [...args];
    return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return true; } }; } };
  return capture;
}
function sha256(path) { return createHash("sha256").update(readFileSync(path, "utf8").replaceAll("\r\n", "\n")).digest("hex"); }
