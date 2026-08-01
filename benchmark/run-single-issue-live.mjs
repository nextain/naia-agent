#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SingleIssueOrchestrator } from "../dist/main/app/single-issue-orchestrator.js";
import { makeBudgetedActorPort, ObservedSpendBudget } from "../dist/main/app/observed-spend-budget.js";
import { SqliteIssueOrchestrationStore } from "../dist/main/adapters/sqlite-issue-orchestration-store.js";
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
const priceSnapshotPath = join(here, "orchestration", "openai-price-snapshot-2026-07-29.json");
const priceSnapshotBytes = readFileSync(priceSnapshotPath);
const priceSnapshot = JSON.parse(priceSnapshotBytes.toString("utf8"));
const priceSnapshotSha256 = createHash("sha256").update(priceSnapshotBytes).digest("hex");
const expectedPriceSnapshotSha256 = "36ff2bca30e2823cddda6b207bdf68b3bb15700c5fdc4e0e67792bda44bc6626";
if (priceSnapshotSha256 !== expectedPriceSnapshotSha256 || priceSnapshot.id !== "PRICE-OPENAI-2026-07-29"
  || priceSnapshot.currency !== "USD" || priceSnapshot.token_unit !== 1_000_000
  || !priceSnapshot.captured_at || !priceSnapshot.normalization_method || !corpus.costScope) {
  throw new Error("frozen price snapshot identity or monetary metadata mismatch");
}
const maximumPricedInputTokens = priceSnapshot.applicability?.maximum_input_tokens_without_frozen_long_context_rule;
if (!Number.isSafeInteger(maximumPricedInputTokens) || maximumPricedInputTokens <= 0) {
  throw new Error("frozen price snapshot applicability is unavailable");
}
const pairedCase = corpus.cases.find((item) => item.kind === "live-paired");
if (!pairedCase) throw new Error("frozen paired case missing");
const maxUsd = Number(process.env.NAIA_ORCH_MAX_USD);
const reservedCallUsd = Number(process.env.NAIA_ORCH_RESERVED_CALL_USD);
const actorTimeoutMs = Number(process.env.NAIA_ORCH_MAX_ACTOR_MS ?? 120_000);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("NAIA_ORCH_MAX_USD must be an explicit positive observed-spend stop threshold");
if (!Number.isFinite(reservedCallUsd) || reservedCallUsd <= 0 || reservedCallUsd > maxUsd) throw new Error("NAIA_ORCH_RESERVED_CALL_USD must be positive and no greater than NAIA_ORCH_MAX_USD");
if (!Number.isFinite(actorTimeoutMs) || actorTimeoutMs <= 0) throw new Error("NAIA_ORCH_MAX_ACTOR_MS must be positive");
if (process.env.NAIA_ORCH_WORKER_MODEL !== undefined) throw new Error("NAIA_ORCH_WORKER_MODEL is forbidden: worker bindings are frozen in the corpus");

const prices = Object.fromEntries(Object.entries(priceSnapshot.models).map(([model, value]) => [model, {
  uncachedInput: value.api_usd_per_million.uncached_input,
  cachedInput: value.api_usd_per_million.cached_input,
  output: value.api_usd_per_million.output,
}]));
const diag = { log(message, detail) { console.error(`[diag] ${message}`, detail ?? ""); }, debug() {} };
const tempRoot = mkdtempSync(join(tmpdir(), "naia-orch-live-"));
const maxPaidCalls = 8;
const spendBudget = new ObservedSpendBudget(maxUsd, reservedCallUsd, maxPaidCalls);

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
function priced(model, reasoningEffort) {
  const price = prices[model];
  if (!price) throw new Error(`model missing from frozen price snapshot: ${model}`);
  return makeCodexSubAgent({ model, reasoningEffort, priceUsdPerMillion: price, maximumPricedInputTokens });
}
function budgeted(port, method, paid = true) {
  return makeBudgetedActorPort(port, method, spendBudget, paid);
}

async function runRoute(routeId, route) {
  const repo = fixture(routeId);
  const worktreeRoot = join(tempRoot, routeId, "worktrees");
  const store = new SqliteIssueOrchestrationStore(join(tempRoot, routeId, "issues.db"));
  const verifier = makeCommandVerifier({ checks: [
    { name: "node --test math.test.mjs passes", command: process.execPath, args: ["--test", "math.test.mjs"] },
    { name: "only math.mjs changed", command: "sh", args: ["-c", "test \"$(git status --porcelain | cut -c4-)\" = math.mjs"] },
  ] });
  const workerModel = route.worker;
  if (!prices[workerModel]) throw new Error(`frozen worker model has no pinned price: ${workerModel}`);
  const facingBinding = { provider: "openai-codex", model: route.naia, reasoningEffort: route.naiaReasoning };
  const moderatorBinding = { provider: "openai-codex", model: route.moderator, reasoningEffort: route.moderatorReasoning };
  const orchestrator = new SingleIssueOrchestrator({
    store,
    facing: budgeted(makeSubAgentNaiaFacing({ subAgent: priced(route.naia, route.naiaReasoning), binding: facingBinding, timeoutMs: actorTimeoutMs, workdir: repo, diag }), "classify"),
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
      requiredObligations: pairedCase.obligations,
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
  const result = {
    schemaVersion: 1, benchmarkId: corpus.benchmarkId, caseId: pairedCase.id, executedAt: new Date().toISOString(),
    priceSnapshot: {
      id: priceSnapshot.id, sha256: priceSnapshotSha256, capturedAt: priceSnapshot.captured_at,
      currency: priceSnapshot.currency, tokenUnit: priceSnapshot.token_unit,
      normalizationMethod: priceSnapshot.normalization_method, applicability: priceSnapshot.applicability,
      costScope: corpus.costScope,
    },
    budget: { observedSpendStopThresholdUsd: maxUsd, reservedCallUsd, actorTimeoutMs, maxPaidCalls, paidCalls: spendBudget.paidCalls, observedSpendUsd: spendBudget.observedSpendUsd, hardProviderDollarCeiling: false },
    corpus, runs: { lunaProxy, allSol }, comparison,
  };
  const output = resolve(process.env.NAIA_ORCH_OUT ?? join(here, "results", `single-issue-live-${Date.now()}.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ output, comparison, hardGates: { lunaProxy: lunaProxy.hardGates, allSol: allSol.hardGates } }, null, 2));
  if (!bothPass) process.exitCode = 1;
} finally {
  if (process.env.NAIA_ORCH_KEEP_FIXTURE !== "1") rmSync(tempRoot, { recursive: true, force: true });
}
