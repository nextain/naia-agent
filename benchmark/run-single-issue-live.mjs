#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SingleIssueOrchestrator } from "../dist/main/app/single-issue-orchestrator.js";
import { SqliteIssueOrchestrationStore } from "../dist/main/adapters/sqlite-issue-orchestration-store.js";
import { IssueActorResultError } from "../dist/main/ports/issue-orchestration.js";
import { makeCodexSubAgent } from "../dist/main/adapters/subagent-codex.js";
import { makeSubAgentDevelopmentModerator, makeSubAgentNaiaFacing, makeSubAgentNaiaReporter, makeIssueVerifierAdapter } from "../dist/main/adapters/subagent-issue-actors.js";
import { makeSupervisedIssueWorker } from "../dist/main/composition/supervised-issue-worker.js";
import { makeGitCodingJobWorktrees } from "../dist/main/adapters/coding-job-worktree.js";
import { makeCommandVerifier } from "../dist/main/adapters/verifier-commands.js";
import { identitiesIndependent, measuredRoles, orderedObligationsEqual } from "../dist/main/domain/orchestration-benchmark.js";

if (process.env.NAIA_ORCH_LIVE !== "1") {
  console.error("Paid live benchmark is opt-in. Set NAIA_ORCH_LIVE=1 after reviewing the frozen corpus.");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "orchestration", "single-issue-cases.json"), "utf8"));
const pairedCase = corpus.cases.find((item) => item.kind === "live-paired");
if (!pairedCase) throw new Error("frozen paired case missing");
const maxUsd = Number(process.env.NAIA_ORCH_MAX_USD);
const reservedCallUsd = Number(process.env.NAIA_ORCH_RESERVED_CALL_USD);
const actorTimeoutMs = Number(process.env.NAIA_ORCH_MAX_ACTOR_MS ?? 120_000);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("NAIA_ORCH_MAX_USD must be an explicit positive observed-spend stop threshold");
if (!Number.isFinite(reservedCallUsd) || reservedCallUsd <= 0 || reservedCallUsd > maxUsd) throw new Error("NAIA_ORCH_RESERVED_CALL_USD must be positive and no greater than NAIA_ORCH_MAX_USD");
if (!Number.isFinite(actorTimeoutMs) || actorTimeoutMs <= 0) throw new Error("NAIA_ORCH_MAX_ACTOR_MS must be positive");

const prices = {
  "gpt-5.6-sol": { uncachedInput: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6-terra": { uncachedInput: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.6-luna": { uncachedInput: 1, cachedInput: 0.1, output: 6 }
};
const diag = { log(message, detail) { console.error(`[diag] ${message}`, detail ?? ""); }, debug() {} };
const tempRoot = mkdtempSync(join(tmpdir(), "naia-orch-live-"));
let observedSpendUsd = 0;
const chargedReceipts = new Set();
const maxPaidCalls = 8;
let paidCalls = 0;

function git(args, cwd) { execFileSync("git", args, { cwd, stdio: "ignore" }); }
function fixture(routeId) {
  const repo = join(tempRoot, routeId, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "math.mjs"), "export function add(a, b) { return a - b; }\n");
  writeFileSync(join(repo, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "benchmark@localhost"], repo);
  git(["config", "user.name", "Naia Benchmark"], repo);
  git(["add", "."], repo);
  git(["commit", "-m", "frozen fixture"], repo);
  return repo;
}
function priced(model, reasoningEffort) { return makeCodexSubAgent({ model, reasoningEffort, priceUsdPerMillion: prices[model] }); }
function chargeMeasuredReceipt(receipt, method, paid) {
  if (!receipt || receipt.cost.state !== "measured") throw new Error(`benchmark ${method} cost unavailable`);
  const receiptKey = `${receipt.role}:${receipt.idempotencyKey}:${receipt.executionId}`;
  if (!chargedReceipts.has(receiptKey)) {
    chargedReceipts.add(receiptKey);
    observedSpendUsd += receipt.cost.usd;
  }
  if (paid && receipt.cost.usd > reservedCallUsd) throw new Error(`benchmark ${method} exceeded its reserved call budget`);
  if (observedSpendUsd > maxUsd) throw new Error(`benchmark observed-spend threshold exceeded after ${method}`);
}
function budgeted(port, method, paid = true) {
  return {
    ...port,
    async [method](input) {
      if (paid && paidCalls >= maxPaidCalls) throw new Error(`benchmark paid-call limit reached before ${method}`);
      if (paid && observedSpendUsd + reservedCallUsd > maxUsd) throw new Error(`benchmark reserved call budget unavailable before ${method}`);
      if (paid) paidCalls += 1;
      try {
        const result = await port[method](input);
        chargeMeasuredReceipt(result.receipt, method, paid);
        return result;
      } catch (error) {
        if (paid && error instanceof IssueActorResultError) chargeMeasuredReceipt(error.receipt, method, paid);
        throw error;
      }
    },
  };
}

async function runRoute(routeId, route) {
  const repo = fixture(routeId);
  const worktreeRoot = join(tempRoot, routeId, "worktrees");
  const store = new SqliteIssueOrchestrationStore(join(tempRoot, routeId, "issues.db"));
  const verifier = makeCommandVerifier({ checks: [
    { name: "node --test math.test.mjs passes", command: process.execPath, args: ["--test", "math.test.mjs"] },
    { name: "only math.mjs changed", command: "sh", args: ["-c", "test \"$(git status --porcelain | cut -c4-)\" = math.mjs"] },
  ] });
  const workerModel = routeId === "allSol" ? "gpt-5.6-sol" : (process.env.NAIA_ORCH_WORKER_MODEL ?? "gpt-5.6-terra");
  const facingBinding = { provider: "openai-codex", model: route.naia, reasoningEffort: route.naiaReasoning };
  const moderatorBinding = { provider: "openai-codex", model: route.moderator, reasoningEffort: route.moderatorReasoning };
  const orchestrator = new SingleIssueOrchestrator({
    store,
    facing: budgeted(makeSubAgentNaiaFacing({ subAgent: priced(route.naia, route.naiaReasoning), binding: facingBinding, requiredObligations: pairedCase.obligations, timeoutMs: actorTimeoutMs, workdir: repo, diag }), "classify"),
    moderator: budgeted(makeSubAgentDevelopmentModerator({ subAgent: priced(route.moderator, route.moderatorReasoning), binding: moderatorBinding, allowedWorkerProfiles: [route.workerProfile], allowedAcceptanceChecks: pairedCase.acceptanceChecks, timeoutMs: actorTimeoutMs, workdir: repo, diag }), "plan"),
    worker: budgeted(makeSupervisedIssueWorker({
      worktrees: makeGitCodingJobWorktrees({ allowedWorkspaceRoot: tempRoot, worktreeRoot }),
      subAgent: priced(workerModel, route.workerReasoning), diag,
    }), "execute"),
    verifier: budgeted(makeIssueVerifierAdapter(verifier), "verify", false),
    reporter: budgeted(makeSubAgentNaiaReporter({ subAgent: priced(route.reporter, route.reporterReasoning), binding: { provider: "openai-codex", model: route.reporter, reasoningEffort: route.reporterReasoning }, timeoutMs: actorTimeoutMs, workdir: repo, diag }), "report"),
  });
  try {
    const report = await orchestrator.start({
      requestId: `${corpus.benchmarkId}:${pairedCase.id}:${routeId}`,
      text: `${pairedCase.request}\nRequired obligations: ${pairedCase.obligations.join("; ")}\nAcceptance checks: ${pairedCase.acceptanceChecks.join("; ")}`,
      workspacePath: repo,
      naiaBinding: facingBinding,
      moderatorBinding,
      workerProfiles: { [route.workerProfile]: { provider: "openai-codex", model: workerModel, reasoningEffort: route.workerReasoning } },
    });
    const issue = orchestrator.snapshot(report.issueId);
    const eventTypes = store.events(issue.issueId).map((event) => event.type);
    const hardGates = {
      terminal_completed: report.state === "completed",
      all_acceptance_checks_pass: report.verificationPassed === true && issue.verification?.checks.every((check) => check.pass) === true,
      obligations_preserved: orderedObligationsEqual(issue.classification?.obligations, pairedCase.obligations),
      independent_actor_identities: identitiesIndependent(issue.receipts),
      stable_dispatch_id: Boolean(issue.dispatchId) && eventTypes.filter((type) => type === "worker_dispatched").length === 1,
      profile_request_exact: issue.plan?.workerProfile === route.workerProfile
        && issue.worker?.receipt.provider === "openai-codex"
        && issue.worker.receipt.model === workerModel
        && issue.worker.receipt.reasoningEffort === route.workerReasoning
        && issue.worker.receipt.modelEvidenceSource === "adapter_requested",
      all_required_receipts_measured: measuredRoles(issue.receipts, corpus.requiredReceiptRoles),
    };
    return { routeId, bindings: { naia: facingBinding, moderator: moderatorBinding, worker: { provider: "openai-codex", model: workerModel, reasoningEffort: route.workerReasoning, profile: route.workerProfile }, reporter: { provider: "openai-codex", model: route.reporter, reasoningEffort: route.reporterReasoning } }, report, hardGates, receipts: issue.receipts, eventTypes };
  } finally { store.close(); }
}

function cost(run) { return run.receipts.reduce((sum, receipt) => sum + (receipt.cost.state === "measured" ? receipt.cost.usd : 0), 0); }

try {
  const lunaProxy = await runRoute("lunaProxy", corpus.routes.lunaProxy);
  const allSol = await runRoute("allSol", corpus.routes.allSol);
  const bothPass = [lunaProxy, allSol].every((run) => Object.values(run.hardGates).every(Boolean));
  const comparison = bothPass
    ? { claimAllowed: true, lunaProxyUsd: cost(lunaProxy), allSolUsd: cost(allSol), savingsUsd: cost(allSol) - cost(lunaProxy) }
    : { claimAllowed: false, lunaProxyUsd: null, allSolUsd: null, savingsUsd: null, reason: "quality or receipt hard gate failed" };
  const result = { schemaVersion: 1, benchmarkId: corpus.benchmarkId, caseId: pairedCase.id, executedAt: new Date().toISOString(), budget: { observedSpendStopThresholdUsd: maxUsd, reservedCallUsd, actorTimeoutMs, maxPaidCalls, paidCalls, observedSpendUsd, hardProviderDollarCeiling: false }, corpus, runs: { lunaProxy, allSol }, comparison };
  const output = resolve(process.env.NAIA_ORCH_OUT ?? join(here, "results", `single-issue-live-${Date.now()}.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ output, comparison, hardGates: { lunaProxy: lunaProxy.hardGates, allSol: allSol.hardGates } }, null, 2));
  if (!bothPass) process.exitCode = 1;
} finally {
  if (process.env.NAIA_ORCH_KEEP_FIXTURE !== "1") rmSync(tempRoot, { recursive: true, force: true });
}
