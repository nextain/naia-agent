#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureMixedLiveExecutionEvidence, sealMixedIssueTeamLive } from "./seal-mixed-issue-team-live.mjs";

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

const artifactRoot = `${outputPath}.artifacts`;
mkdirSync(artifactRoot, { recursive: false, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, benchmarkId, status: "running",
  paidCalls: 0, maximumPaidCalls: 7, artifactRoot }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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
  const result = await worker.execute({ issueId: "mixed-live-001", dispatchId: "mixed-live-001:dispatch:1",
    workspacePath: fixtureRoot, task, obligations: ["result.txt bytes equal NAIA_MIXED_TEAM_OK\\n", "seed.txt remains unchanged"],
    acceptanceChecks: ["read result.txt and compare exact bytes", "read seed.txt and compare exact bytes"],
    profileId: "mixed-live-balanced", profile, signal: new AbortController().signal });
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
  payload = { schemaVersion: 1, benchmarkId, status: passed ? "passed" : "failed", paidCalls,
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
    diagnostics, executionEvidence, artifactRoot, claimAllowed: passed };
  if (!passed) process.exitCode = 2;
} catch (error) {
  payload = { schemaVersion: 1, benchmarkId, status: "failed", paidCalls, maximumPaidCalls: 7,
    reason: error instanceof Error ? error.message : String(error), diagnostics, artifactRoot, claimAllowed: false };
  process.exitCode = 2;
} finally {
  store.close();
}
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
const sealed = payload.claimAllowed
  ? sealMixedIssueTeamLive({ receiptPath: outputPath, sourceCommit: executionEvidence.sourceCommit,
    requireCurrentSourceMatch: true }) : payload;
process.stdout.write(`${JSON.stringify(sealed, null, 2)}\n`);
