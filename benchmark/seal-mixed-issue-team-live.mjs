#!/usr/bin/env node
import { closeSync, constants, fstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { captureMixedLiveExecutionEvidence, validateExecutionEvidence,
  validateLiveExecutionInputs } from "./mixed-live-execution-evidence.mjs";
import { pickCoreAssertions, projectReceipt, validateDurableReceipts, validateDurableRun,
  validateOutcomeSchemas } from "./mixed-live-durable-validation.mjs";
import { assertArtifactSnapshot, assertChildMatchesDescriptor, assertPathMatchesDescriptor, assertTrackedEvidence,
  normalizeSqliteToDeleteJournal, openChildNoFollow, openPathFromRepository, readChildNoFollow,
  writeJsonBoundFile } from "./mixed-live-secure-files.mjs";
import { git, sha256, stableJson } from "./mixed-live-seal-utils.mjs";

const scriptPath = fileURLToPath(import.meta.url);

export { captureMixedLiveExecutionEvidence, validateLiveExecutionInputs };

export function sealMixedIssueTeamLive({ receiptPath: inputPath, sourceCommit, requireCurrentSourceMatch = false,
  verifyExistingSeal = false, evidenceCommit, boundReceiptFd, beforeFinalEvidenceCheck }) {
  const receiptPath = resolve(inputPath);
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit must be full 40-hex");
  const repositoryRoot = git(dirname(receiptPath), ["rev-parse", "--show-toplevel"]);
  const receiptParentPath = dirname(receiptPath);
  const receiptParentFd = openPathFromRepository(repositoryRoot, receiptParentPath, "directory");
  const receiptParentIdentity = fstatSync(receiptParentFd);
  try {
  const ownsReceiptFd = boundReceiptFd === undefined;
  const receiptFd = ownsReceiptFd ? openChildNoFollow(receiptParentFd, basename(receiptPath), "file",
    verifyExistingSeal ? constants.O_RDONLY : constants.O_RDWR) : boundReceiptFd;
  const receiptIdentity = fstatSync(receiptFd);
  try {
  if (!receiptIdentity.isFile()) throw new Error("bound receipt descriptor is not a regular file");
  assertChildMatchesDescriptor(receiptParentFd, basename(receiptPath), receiptIdentity, "file");
  const receiptBytes = readFileSync(receiptFd);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const expectedClaimAllowed = verifyExistingSeal;
  if (receipt.status !== "passed" || receipt.claimAllowed !== expectedClaimAllowed || !Array.isArray(receipt.receipts)) {
    throw new Error(verifyExistingSeal ? "only a passed, claim-allowed mixed-team receipt can be verified"
      : "only a passed, non-claimable mixed-team receipt can be sealed");
  }
  validateExecutionEvidence(receipt.executionEvidence, repositoryRoot, sourceCommit, requireCurrentSourceMatch);

  const artifactRoot = `${receiptPath}.artifacts`;
  const artifactFd = openChildNoFollow(receiptParentFd, basename(artifactRoot), "directory", constants.O_RDONLY);
  try {
  const artifactIdentity = fstatSync(artifactFd);
  const artifactFdPath = `/proc/self/fd/${artifactFd}`;
  const expectedArtifactRoot = relative(repositoryRoot, artifactRoot).split("\\").join("/");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.runId)
    || receipt.artifactBindingPath !== expectedArtifactRoot || !isAbsolute(receipt.executionArtifactRoot)
    || (!verifyExistingSeal && receipt.executionArtifactRoot !== realpathSync(artifactFdPath))) {
    throw new Error("live evidence run ID or artifact binding does not match its execution path");
  }
  const initialSqliteNames = readdirSync(artifactFdPath).filter((name) => name.startsWith("team.db")).sort();
  if (!initialSqliteNames.includes("team.db")
    || initialSqliteNames.some((name) => !["team.db", "team.db-shm", "team.db-wal"].includes(name))) {
    throw new Error("SQLite evidence contains an unexpected journal or sidecar");
  }
  for (const name of initialSqliteNames) {
    const bytes = readChildNoFollow(artifactFd, name);
    if (name === "team.db-wal" && bytes.length !== 0) {
      throw new Error("SQLite WAL must be checkpointed and empty before sealing");
    }
  }
  if (!verifyExistingSeal) normalizeSqliteToDeleteJournal(join(artifactFdPath, "team.db"));
  const sqliteNames = readdirSync(artifactFdPath).filter((name) => name.startsWith("team.db")).sort();
  if (JSON.stringify(sqliteNames) !== JSON.stringify(["team.db"])) {
    throw new Error("SQLite evidence is not a checkpointed self-contained database");
  }
  if (process.platform !== "linux") throw new Error("secure descriptor-backed SQLite evidence verification requires Linux");
  const databaseFd = openChildNoFollow(artifactFd, "team.db", "file", constants.O_RDONLY);
  let databaseIdentity; let databaseBytes; let sqliteFiles; let runs; let events;
  try {
    databaseIdentity = fstatSync(databaseFd);
    databaseBytes = readFileSync(databaseFd);
    sqliteFiles = [{ path: "team.db", byteLength: databaseBytes.length, sha256: sha256(databaseBytes) }];
    const database = new Database(`/proc/self/fd/${databaseFd}`, { readonly: true, fileMustExist: true });
    try {
      runs = database.prepare("SELECT dispatch_id,version,fingerprint,state,snapshot_json FROM issue_team_runs").all();
      events = database.prepare("SELECT dispatch_id,sequence,event_type,state FROM issue_team_events ORDER BY dispatch_id,sequence").all();
    } finally { database.close(); }
    if (sha256(readFileSync(`/proc/self/fd/${databaseFd}`)) !== sqliteFiles[0].sha256) {
      throw new Error("SQLite evidence changed while its durable state was queried");
    }
    assertChildMatchesDescriptor(artifactFd, "team.db", databaseIdentity, "file");
  } finally { closeSync(databaseFd); }
  if (runs.length !== 1) throw new Error("live evidence must contain exactly one durable team run");
  const run = runs[0]; const snapshot = JSON.parse(String(run.snapshot_json));
  validateDurableRun(run, snapshot, events, receipt.runId, receipt.artifactBindingPath,
    receipt.executionArtifactRoot);
  const projected = snapshot.receipts.map(projectReceipt);
  if (JSON.stringify(projected) !== JSON.stringify(receipt.receipts)) {
    throw new Error("receipt projection does not match the durable SQLite snapshot");
  }
  const profileDigest = sha256(Buffer.from(stableJson(receipt.profile)));
  if (profileDigest !== snapshot.profileDigest) throw new Error("profile does not match the durable SQLite snapshot");
  validateDurableReceipts(snapshot, receipt.profile);
  validateOutcomeSchemas(snapshot);
  for (const roleReceipt of projected) {
    const role = receipt.profile?.roles?.[roleReceipt.workerRole];
    if (!role || role.agentKind !== roleReceipt.agentKind || role.binding?.provider !== roleReceipt.provider
      || role.binding?.model !== roleReceipt.model || role.binding?.reasoningEffort !== roleReceipt.reasoningEffort) {
      throw new Error("profile role binding does not match durable receipt evidence");
    }
  }

  const fixtureFd = openChildNoFollow(artifactFd, "fixture", "directory", constants.O_RDONLY);
  const fixtureFdPath = `/proc/self/fd/${fixtureFd}`;
  let fixture;
  try {
    fixture = readdirSync(fixtureFdPath).sort().map((name) => {
      const bytes = readChildNoFollow(fixtureFd, name);
      return { path: name, byteLength: bytes.length, sha256: sha256(bytes), hex: bytes.toString("hex") };
    });
  } finally { closeSync(fixtureFd); }
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
  const claimScope = { sessionIdentity: "provider_reported", providerIdentity: "adapter_declared_not_provider_observed",
    modelIdentity: "adapter_requested_not_provider_observed",
    executionRuntimeIdentity: "path_hash_observed_at_boundaries_not_execution_pinned",
    capability: "mixed_adapter_execution", verificationPortability: "linux_clean_checkout_after_locked_install_and_build" };
  const convergencePaths = coreResult.repairCycles === 0 ? [{
    roles: ["explorer", "implementer", "tester", "reviewer"],
    decisions: ["explorer:proceed", "implementer:implemented", "tester:pass", "reviewer:clean"],
  }] : coreResult.repairCycles === 1 ? [{
    roles: ["explorer", "implementer", "tester", "implementer", "tester", "reviewer"],
    decisions: ["explorer:proceed", "implementer:implemented", "tester:fail", "implementer:implemented",
      "tester:pass", "reviewer:clean"],
  }, {
    roles: ["explorer", "implementer", "tester", "reviewer", "implementer", "tester", "reviewer"],
    decisions: ["explorer:proceed", "implementer:implemented", "tester:pass", "reviewer:changes_requested",
      "implementer:implemented", "tester:pass", "reviewer:clean"],
  }] : [];
  const observedRoles = projected.map((value) => value.workerRole);
  const observedDecisions = snapshot.outcomes?.map((value) => `${value.role}:${value.decision}`);
  const convergenceMatches = convergencePaths.some((path) => JSON.stringify(observedRoles) === JSON.stringify(path.roles)
    && JSON.stringify(observedDecisions) === JSON.stringify(path.decisions));
  if (receipt.schemaVersion !== 1 || receipt.benchmarkId !== "mixed-issue-team-live-v1"
    || receipt.maximumPaidCalls !== 7 || receipt.paidCalls !== projected.length
    || coreResult.ok !== true || !convergenceMatches
    || JSON.stringify(coreResult.changedFiles) !== JSON.stringify(["result.txt"])
    || coreResult.cleanCycles !== 1
    || coreAssertions.evidenceComplete !== true || coreAssertions.mixedAppsObserved !== true
    || JSON.stringify(receipt.claimScope) !== JSON.stringify(claimScope)
    || JSON.stringify(coreAssertions.roleKinds) !== JSON.stringify({ explorer: "claude-code",
      implementer: "opencode", tester: "codex", reviewer: "codex" })
    || JSON.stringify(receipt.result) !== JSON.stringify(coreResult)
    || JSON.stringify(pickCoreAssertions(receipt.assertions)) !== JSON.stringify(coreAssertions)) {
    throw new Error("receipt summary does not match durable state and exact fixture evidence");
  }

  const normalizedSnapshot = JSON.parse(JSON.stringify(snapshot).split(receipt.executionArtifactRoot).join("$ARTIFACT_ROOT"));
  const durableRun = { dispatchId: run.dispatch_id, version: run.version, fingerprint: run.fingerprint,
    state: run.state, normalizedSnapshot };
  const expectedEmbeddedEvidence = { ...receipt.executionEvidence, sqliteFiles,
    sqliteSha256: sqliteFiles.find((value) => value.path === "team.db").sha256,
    durableRun, durableRunSha256: sha256(Buffer.from(JSON.stringify(durableRun))), events, fixture };
  const expectedAssertions = { ...coreAssertions, durableEvidenceEmbedded: true, receiptMatchesDurableSnapshot: true };
  beforeFinalEvidenceCheck?.();
  assertArtifactSnapshot(artifactFd, databaseIdentity, sqliteFiles[0].sha256, fixture);
  assertChildMatchesDescriptor(receiptParentFd, basename(artifactRoot), artifactIdentity, "directory");
  assertPathMatchesDescriptor(receiptParentPath, receiptParentIdentity, "directory");
  if (verifyExistingSeal) {
    if (!receipt.embeddedEvidence || receipt.artifactRoot !== expectedArtifactRoot
      || JSON.stringify(receipt.embeddedEvidence) !== JSON.stringify(expectedEmbeddedEvidence)
      || JSON.stringify(receipt.assertions) !== JSON.stringify(expectedAssertions)) {
      throw new Error("sealed receipt evidence does not match the immutable execution artifacts");
    }
    if (expectedArtifactRoot.startsWith(".agents/reviews/")) {
      if (!evidenceCommit) throw new Error("tracked evidence verification requires an immutable evidence commit");
      assertTrackedEvidence(repositoryRoot, evidenceCommit, receiptPath, artifactRoot, receiptBytes, databaseBytes,
        fixture);
    }
    return receipt;
  }
  if (receipt.embeddedEvidence !== undefined) throw new Error("receipt is already sealed; use sealed verification mode");
  const sealed = { ...receipt, claimAllowed: true, artifactRoot: expectedArtifactRoot,
    embeddedEvidence: expectedEmbeddedEvidence, assertions: expectedAssertions };
  // This descriptor-backed write is the publication commit point. All fallible
  // artifact/path validation must stay above it so a reported sealing failure
  // can never leave a pathname-reachable claimable receipt behind.
  writeJsonBoundFile(receiptParentFd, basename(receiptPath), receiptFd, receiptIdentity, receiptBytes, sealed);
  return sealed;
  } finally { closeSync(artifactFd); }
  } finally { if (ownsReceiptFd) closeSync(receiptFd); }
  } finally { closeSync(receiptParentFd); }
}

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
  const evidenceIndex = process.argv.indexOf("--evidence-commit");
  const evidenceCommit = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined;
  const sealUnsealed = process.argv.includes("--seal-unsealed"); const verifySealed = process.argv.includes("--verify-sealed");
  if (!receiptPath || !sourceCommit || sealUnsealed === verifySealed) {
    throw new Error("usage: seal-mixed-issue-team-live.mjs --receipt <path> --source-commit <commit> (--seal-unsealed|--verify-sealed)");
  }
  sealMixedIssueTeamLive({ receiptPath, sourceCommit, requireCurrentSourceMatch: true,
    verifyExistingSeal: verifySealed, evidenceCommit });
}
