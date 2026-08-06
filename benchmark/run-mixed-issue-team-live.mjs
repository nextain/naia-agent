#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { captureMixedLiveExecutionEvidence, sealMixedIssueTeamLive,
  validateLiveExecutionInputs } from "./seal-mixed-issue-team-live.mjs";
import { createChildFileNoFollow, openPathFromRepository,
  writeJsonBoundFile } from "./mixed-live-secure-files.mjs";

const benchmarkId = "mixed-issue-team-live-v1";
const outputIndex = process.argv.indexOf("--output");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
const outputPath = outputArgument ? resolve(outputArgument) : undefined;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const confirmed = process.argv.includes("--confirm-seven-paid-calls")
  && process.env.NAIA_MIXED_TEAM_LIVE_CONFIRM === "1";
const opencodeBinding = process.env.NAIA_MIXED_OPENCODE_MODEL === "opencode/deepseek-v4-flash-free"
  ? { provider: "opencode", model: "opencode/deepseek-v4-flash-free" }
  : { provider: "azure-foundry", model: "azure-foundry/gpt-5-4-nano" };
const reason = !confirmed ? "explicit seven-paid-call maximum confirmation missing"
  : !outputPath ? "durable --output path is required"
  : existsSync(outputPath) || existsSync(`${outputPath}.artifacts`) ? "output or artifact path already exists"
  : undefined;
if (reason) {
  const payload = { schemaVersion: 1, benchmarkId, status: "unavailable", paidCalls: 0,
    maximumPaidCalls: 7, reason, claimAllowed: false };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(0);
}
const executionEvidence = captureMixedLiveExecutionEvidence(repositoryRoot);
const runId = randomUUID();

const artifactRoot = `${outputPath}.artifacts`;
mkdirSync(artifactRoot, { recursive: false, mode: 0o700 });
const executionArtifactRoot = realpathSync(artifactRoot);
const artifactBindingPath = relative(repositoryRoot, artifactRoot).split("\\").join("/");
const runBinding = createHash("sha256").update(`${runId}\0${artifactBindingPath}`).digest("hex");
const claimScope = { sessionIdentity: "provider_reported", providerIdentity: "adapter_declared_not_provider_observed",
  modelIdentity: "adapter_requested_not_provider_observed",
  executionRuntimeIdentity: "path_hash_observed_at_boundaries_not_execution_pinned",
  capability: "mixed_adapter_execution",
  verificationPortability: "same_linux_host_clean_checkout_with_locked_dependencies_and_exact_bound_external_toolchain",
  claimEvidence: "atomically_published_self_contained_receipt_evidence",
  externalArtifacts: "non_authoritative_working_copy_excluded_from_claim_after_capture" };
const receiptParentFd = openPathFromRepository(repositoryRoot, dirname(outputPath), "directory");
const receiptFd = createChildFileNoFollow(receiptParentFd, basename(outputPath));
const receiptIdentity = fstatSync(receiptFd);
let receiptBytes = Buffer.alloc(0);
function writeReceipt(value) {
  writeJsonBoundFile(receiptParentFd, basename(outputPath), receiptFd, receiptIdentity, receiptBytes, value);
  receiptBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
writeReceipt({ schemaVersion: 1, benchmarkId, status: "running",
  runId, paidCalls: 0, maximumPaidCalls: 7, artifactRoot, artifactBindingPath, executionArtifactRoot,
  claimScope, claimAllowed: false });
const fixtureRoot = join(artifactRoot, "fixture");
mkdirSync(fixtureRoot, { mode: 0o700 });
writeFileSync(join(fixtureRoot, "seed.txt"), "SEED_MUST_STAY\n", { mode: 0o600 });

const dist = new URL("../dist/main/", import.meta.url);
const [{ makeIssueTeamWorker }, { SqliteIssueTeamStore }, { makeIssueTeamRoleExecutor },
  { composeIssueTeamAgents }, { endedSession }] = await Promise.all([
  import(new URL("app/issue-team-worker.js", dist).href),
  import(new URL("adapters/sqlite-issue-team-store.js", dist).href),
  import(new URL("composition/issue-team-role-executor.js", dist).href),
  import(new URL("composition/mixed-issue-team-agents.js", dist).href),
  import(new URL("adapters/subprocess-session.js", dist).href),
]);
validateLiveExecutionInputs(executionEvidence, repositoryRoot);

const profile = { kind: "team", maxRepairCycles: 1, requiredCleanCycles: 1, roles: {
  explorer: { agentProfileId: "claude-explorer", agentKind: "claude-code",
    binding: { provider: "claude-code", model: "sonnet" }, filesystemAccess: "read_only" },
  implementer: { agentProfileId: "opencode-implementer", agentKind: "opencode",
    binding: opencodeBinding, filesystemAccess: "workspace_write" },
  tester: { agentProfileId: "codex-tester", agentKind: "codex",
    binding: { provider: "openai-codex", model: "gpt-5.3-codex-spark", reasoningEffort: "low" }, filesystemAccess: "read_only" },
  reviewer: { agentProfileId: "codex-reviewer", agentKind: "codex",
    binding: { provider: "openai-codex", model: "gpt-5.3-codex-spark", reasoningEffort: "low" }, filesystemAccess: "read_only" },
} };

let paidCalls = 0;
const rawAgents = composeIssueTeamAgents(profile, {
  claudeCode: { skipPermissions: true, resolveBin: () => ({ command: executionEvidence.executables.claude.path, prefixArgs: [] }) },
  opencode: { skipPermissions: true, resolveBin: () => ({ command: executionEvidence.executables.opencode.path, prefixArgs: [] }) },
  codex: { skipGitRepoCheck: true, resolveBin: () => ({ command: executionEvidence.executables.node.path,
    prefixArgs: [executionEvidence.executables.codex.path] }) },
});
const agents = Object.fromEntries(Object.entries(rawAgents).map(([id, selected]) => [id, {
  ...selected,
  adapter: {
    spawn(task) {
      if (paidCalls >= 7) return endedSession("mixed live paid-call ceiling reached");
      validateLiveExecutionInputs(executionEvidence, repositoryRoot);
      paidCalls += 1;
      return selected.adapter.spawn(task);
    },
  },
}]));
const diagnostics = [];
const diag = { log(message, data) { diagnostics.push({ level: "log", message, data }); },
  debug(message, data) { diagnostics.push({ level: "debug", message, data }); } };
const store = new SqliteIssueTeamStore(join(artifactRoot, "team.db"));
const roles = makeIssueTeamRoleExecutor({ agents, diag, roleDeadlineMs: 180_000 });
const worktrees = { allocate() { return { workspacePath: fixtureRoot, worktreePath: fixtureRoot,
  branch: "live-fixture", leaseId: "live-fixture-lease", release() {} }; }, recover() { return true; } };
const worker = makeIssueTeamWorker({ store, worktrees, roles,
  changedFiles: (path) => readdirSync(path).filter((name) => name !== "seed.txt") });

let payload;
try {
  const task = "Create result.txt with the exact UTF-8 bytes NAIA_MIXED_TEAM_OK followed by one LF. "
    + "Do not modify seed.txt or create any other file.";
  const result = await worker.execute({ issueId: runBinding, dispatchId: `${runId}:dispatch:1`,
    workspacePath: fixtureRoot, task, obligations: ["result.txt bytes equal NAIA_MIXED_TEAM_OK\\n", "seed.txt remains unchanged"],
    acceptanceChecks: ["read result.txt and compare exact bytes", "read seed.txt and compare exact bytes"],
    profileId: "mixed-live-balanced", profile, signal: new AbortController().signal });
  validateLiveExecutionInputs(executionEvidence, repositoryRoot);
  const resultBytes = readFileSync(join(fixtureRoot, "result.txt"), "utf8");
  const seedBytes = readFileSync(join(fixtureRoot, "seed.txt"), "utf8");
  const files = readdirSync(fixtureRoot).sort();
  const receipts = result.receipts ?? [];
  const roleKinds = Object.fromEntries(receipts.map((receipt) => [receipt.workerRole, receipt.agentKind]));
  const evidenceComplete = receipts.length >= 4 && receipts.every((receipt) => receipt.sessionId
    && receipt.sessionEvidenceSource === "provider_reported"
    && ["provider_reported", "adapter_requested"].includes(receipt.modelEvidenceSource)
    && receipt.executionId && receipt.provider && receipt.model);
  const exactArtifacts = resultBytes === "NAIA_MIXED_TEAM_OK\n" && seedBytes === "SEED_MUST_STAY\n"
    && JSON.stringify(files) === JSON.stringify(["result.txt", "seed.txt"]);
  const mixedAppsObserved = new Set(receipts.map((receipt) => receipt.agentKind)).size === 3;
  const passed = result.ok && result.team?.cleanCycles === 1 && exactArtifacts && evidenceComplete && mixedAppsObserved;
  payload = { schemaVersion: 1, benchmarkId, status: passed ? "passed" : "failed", runId, paidCalls, claimScope,
    maximumPaidCalls: 7, profile, result: { ok: result.ok, changedFiles: result.changedFiles,
      cleanCycles: result.team?.cleanCycles, repairCycles: result.team?.repairCycles },
    assertions: { exactArtifacts, evidenceComplete, mixedAppsObserved, roleKinds },
    receipts: receipts.map((receipt) => ({ workerRole: receipt.workerRole, agentKind: receipt.agentKind,
      provider: receipt.provider, model: receipt.model, reasoningEffort: receipt.reasoningEffort,
      sessionId: receipt.sessionId, sessionEvidenceSource: receipt.sessionEvidenceSource,
      modelEvidenceSource: receipt.modelEvidenceSource,
      executionId: receipt.executionId,
      tokenCountsAvailable: receipt.tokenCountsAvailable, inputTokens: receipt.inputTokens,
      cachedInputTokens: receipt.cachedInputTokens, outputTokens: receipt.outputTokens, cost: receipt.cost })),
    diagnostics, executionEvidence, artifactRoot, artifactBindingPath, executionArtifactRoot, claimAllowed: false };
  if (!passed) process.exitCode = 2;
} catch (error) {
  payload = { schemaVersion: 1, benchmarkId, status: "failed", runId, paidCalls, maximumPaidCalls: 7,
    reason: error instanceof Error ? error.message : String(error), diagnostics, artifactRoot, artifactBindingPath,
    executionArtifactRoot,
    claimAllowed: false };
  process.exitCode = 2;
} finally {
  store.close();
}
writeReceipt(payload);
let sealed = payload;
try {
  if (payload.status === "passed") sealed = sealMixedIssueTeamLive({ receiptPath: outputPath,
    sourceCommit: executionEvidence.sourceCommit, requireCurrentSourceMatch: true, boundReceiptFd: receiptFd });
} finally {
  try { closeSync(receiptFd); } catch { /* Process exit releases a descriptor after publication. */ }
  try { closeSync(receiptParentFd); } catch { /* Do not turn a successful atomic publication into failure. */ }
}
process.stdout.write(`${JSON.stringify(sealed, null, 2)}\n`);
