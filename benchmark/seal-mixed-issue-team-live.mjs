#!/usr/bin/env node
import { closeSync, constants, fstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { captureMixedLiveExecutionEvidence, validateExecutionEvidence,
  validateLiveExecutionInputs } from "./mixed-live-execution-evidence.mjs";
import { pickCoreAssertions, projectReceipt, validateDurableReceipts, validateDurableRun,
  validateOutcomeSchemas } from "./mixed-live-durable-validation.mjs";
import { assertArtifactSnapshot, assertChildMatchesDescriptor, assertNoPublicationRecoveryEntries,
  assertPathMatchesDescriptor, assertTrackedReceipt,
  fsyncArtifactEvidence, normalizeSqliteToDeleteJournal, openChildNoFollow, openPathFromRepository, readChildNoFollow,
  publishJsonAtomically, queryEmbeddedSqliteEvidence } from "./mixed-live-secure-files.mjs";
import { git, sha256, stableJson } from "./mixed-live-seal-utils.mjs";

const scriptPath = fileURLToPath(import.meta.url);

export { captureMixedLiveExecutionEvidence, validateLiveExecutionInputs };

export function sealMixedIssueTeamLive({ receiptPath: inputPath, sourceCommit, requireCurrentSourceMatch = false,
  verifyExistingSeal = false, evidenceCommit, boundReceiptFd, beforeFinalEvidenceCheck,
  afterPublicationEvidenceGuardBeforeReceiptValidation, afterPublicationRenameBeforeDirectorySync }) {
  let claimPublished = false;
  const receiptPath = resolve(inputPath);
  if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit must be full 40-hex");
  const repositoryRoot = git(dirname(receiptPath), ["rev-parse", "--show-toplevel"]);
  const receiptParentPath = dirname(receiptPath);
  const receiptParentFd = openPathFromRepository(repositoryRoot, receiptParentPath, "directory");
  const receiptParentIdentity = fstatSync(receiptParentFd);
  try {
  assertNoPublicationRecoveryEntries(receiptParentFd, basename(receiptPath));
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
  if (verifyExistingSeal) {
    return verifySelfContainedReceipt({ receipt, receiptBytes, receiptPath, receiptParentFd, receiptParentPath,
      receiptParentIdentity, receiptIdentity, repositoryRoot, sourceCommit, evidenceCommit });
  }

  const artifactRoot = `${receiptPath}.artifacts`;
  const artifactFd = openChildNoFollow(receiptParentFd, basename(artifactRoot), "directory", constants.O_RDONLY);
  try {
  const artifactIdentity = fstatSync(artifactFd);
  const artifactFdPath = `/proc/self/fd/${artifactFd}`;
  const expectedArtifactRoot = relative(repositoryRoot, artifactRoot).split("\\").join("/");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.runId)
    || receipt.artifactBindingPath !== expectedArtifactRoot || !isAbsolute(receipt.executionArtifactRoot)
    || receipt.executionArtifactRoot !== realpathSync(artifactFdPath)) {
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
  normalizeSqliteToDeleteJournal(join(artifactFdPath, "team.db"));
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
    capability: "mixed_adapter_execution",
    verificationPortability: "same_linux_host_clean_checkout_with_locked_dependencies_and_exact_bound_external_toolchain",
    claimEvidence: "atomically_published_self_contained_receipt_evidence",
    externalArtifacts: "non_authoritative_working_copy_excluded_from_claim_after_capture" };
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
    sqliteHex: databaseBytes.toString("hex"),
    durableRun, durableRunSha256: sha256(Buffer.from(JSON.stringify(durableRun))), events, fixture };
  const expectedAssertions = { ...coreAssertions, durableEvidenceEmbedded: true,
    selfContainedEvidenceEmbedded: true, externalArtifactsExcludedFromClaim: true };
  if (receipt.embeddedEvidence !== undefined) throw new Error("receipt is already sealed; use sealed verification mode");
  const sealed = { ...receipt, claimAllowed: true, artifactRoot: expectedArtifactRoot,
    embeddedEvidence: expectedEmbeddedEvidence, assertions: expectedAssertions };
  // The temporary receipt is complete before this boundary guard runs. The
  // guard durably synchronizes and revalidates every bound artifact, and the
  // publisher revalidates both receipt entries again before rename.
  publishJsonAtomically(receiptParentFd, basename(receiptPath), receiptFd, receiptIdentity, receiptBytes, sealed, {
    beforeRename() {
      beforeFinalEvidenceCheck?.();
      fsyncArtifactEvidence(artifactFd, fixture);
      assertArtifactSnapshot(artifactFd, databaseIdentity, sqliteFiles[0].sha256, fixture);
      assertChildMatchesDescriptor(receiptParentFd, basename(artifactRoot), artifactIdentity, "directory");
      assertPathMatchesDescriptor(receiptParentPath, receiptParentIdentity, "directory");
    },
    afterBeforeRename: afterPublicationEvidenceGuardBeforeReceiptValidation,
    afterRenameBeforeDirectorySync: afterPublicationRenameBeforeDirectorySync,
  });
  claimPublished = true;
  return sealed;
  } finally { try { closeSync(artifactFd); } catch (error) { if (!claimPublished) throw error; } }
  } finally {
    if (ownsReceiptFd) try { closeSync(receiptFd); } catch (error) { if (!claimPublished) throw error; }
  }
  } finally { try { closeSync(receiptParentFd); } catch (error) { if (!claimPublished) throw error; } }
}

function verifySelfContainedReceipt({ receipt, receiptBytes, receiptPath, receiptParentFd, receiptParentPath,
  receiptParentIdentity, receiptIdentity, repositoryRoot, sourceCommit, evidenceCommit }) {
  const embedded = receipt.embeddedEvidence;
  const expectedArtifactRoot = relative(repositoryRoot, `${receiptPath}.artifacts`).split("\\").join("/");
  if (!embedded || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.runId)
    || receipt.artifactRoot !== expectedArtifactRoot || receipt.artifactBindingPath !== expectedArtifactRoot
    || !isAbsolute(receipt.executionArtifactRoot)) {
    throw new Error("sealed receipt identity or self-contained evidence binding is invalid");
  }
  const sqliteHex = embedded.sqliteHex;
  if (typeof sqliteHex !== "string" || sqliteHex.length === 0 || sqliteHex.length % 2 !== 0
    || !/^[0-9a-f]+$/u.test(sqliteHex)) {
    throw new Error("embedded SQLite hex evidence is invalid");
  }
  const databaseBytes = Buffer.from(sqliteHex, "hex");
  const sqliteSha256 = sha256(databaseBytes);
  const sqliteFiles = [{ path: "team.db", byteLength: databaseBytes.length, sha256: sqliteSha256 }];
  if (embedded.sqliteSha256 !== sqliteSha256
    || JSON.stringify(embedded.sqliteFiles) !== JSON.stringify(sqliteFiles)) {
    throw new Error("embedded SQLite bytes do not match their declared hash");
  }
  const fixture = embedded.fixture;
  if (!Array.isArray(fixture) || JSON.stringify(fixture.map((value) => value?.path))
      !== JSON.stringify(["result.txt", "seed.txt"])) {
    throw new Error("embedded fixture evidence is incomplete");
  }
  for (const value of fixture) {
    if (!value || typeof value.hex !== "string" || value.hex.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value.hex)) {
      throw new Error("embedded fixture hex evidence is invalid");
    }
    const bytes = Buffer.from(value.hex, "hex");
    if (value.byteLength !== bytes.length || value.sha256 !== sha256(bytes)) {
      throw new Error("embedded fixture bytes do not match their declared hash");
    }
  }
  if (fixture[0].hex !== Buffer.from("NAIA_MIXED_TEAM_OK\n").toString("hex")
    || fixture[1].hex !== Buffer.from("SEED_MUST_STAY\n").toString("hex")) {
    throw new Error("embedded fixture bytes do not match the live benchmark contract");
  }
  const { runs, events } = queryEmbeddedSqliteEvidence(receiptParentFd, databaseBytes);
  if (runs.length !== 1) throw new Error("embedded evidence must contain exactly one durable team run");
  const run = runs[0]; const snapshot = JSON.parse(String(run.snapshot_json));
  validateDurableRun(run, snapshot, events, receipt.runId, receipt.artifactBindingPath,
    receipt.executionArtifactRoot);
  const projected = snapshot.receipts.map(projectReceipt);
  if (JSON.stringify(projected) !== JSON.stringify(receipt.receipts)) {
    throw new Error("receipt projection does not match the embedded durable SQLite snapshot");
  }
  if (sha256(Buffer.from(stableJson(receipt.profile))) !== snapshot.profileDigest) {
    throw new Error("profile does not match the embedded durable SQLite snapshot");
  }
  validateDurableReceipts(snapshot, receipt.profile);
  validateOutcomeSchemas(snapshot);
  for (const roleReceipt of projected) {
    const role = receipt.profile?.roles?.[roleReceipt.workerRole];
    if (!role || role.agentKind !== roleReceipt.agentKind || role.binding?.provider !== roleReceipt.provider
      || role.binding?.model !== roleReceipt.model || role.binding?.reasoningEffort !== roleReceipt.reasoningEffort) {
      throw new Error("profile role binding does not match embedded durable receipt evidence");
    }
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
  const expectedClaimScope = { sessionIdentity: "provider_reported",
    providerIdentity: "adapter_declared_not_provider_observed",
    modelIdentity: "adapter_requested_not_provider_observed",
    executionRuntimeIdentity: "path_hash_observed_at_boundaries_not_execution_pinned",
    capability: "mixed_adapter_execution",
    verificationPortability: "same_linux_host_clean_checkout_with_locked_dependencies_and_exact_bound_external_toolchain",
    claimEvidence: "atomically_published_self_contained_receipt_evidence",
    externalArtifacts: "non_authoritative_working_copy_excluded_from_claim_after_capture" };
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
  const convergenceMatches = convergencePaths.some((path) =>
    JSON.stringify(projected.map((value) => value.workerRole)) === JSON.stringify(path.roles)
    && JSON.stringify(snapshot.outcomes?.map((value) => `${value.role}:${value.decision}`))
      === JSON.stringify(path.decisions));
  if (receipt.schemaVersion !== 1 || receipt.benchmarkId !== "mixed-issue-team-live-v1"
    || receipt.maximumPaidCalls !== 7 || receipt.paidCalls !== projected.length || coreResult.ok !== true
    || !convergenceMatches || JSON.stringify(coreResult.changedFiles) !== JSON.stringify(["result.txt"])
    || coreResult.cleanCycles !== 1 || coreAssertions.evidenceComplete !== true
    || coreAssertions.mixedAppsObserved !== true
    || JSON.stringify(receipt.claimScope) !== JSON.stringify(expectedClaimScope)
    || JSON.stringify(coreAssertions.roleKinds) !== JSON.stringify({ explorer: "claude-code",
      implementer: "opencode", tester: "codex", reviewer: "codex" })
    || JSON.stringify(receipt.result) !== JSON.stringify(coreResult)
    || JSON.stringify(pickCoreAssertions(receipt.assertions)) !== JSON.stringify(coreAssertions)) {
    throw new Error("sealed receipt summary does not match embedded durable state and fixture evidence");
  }
  const normalizedSnapshot = JSON.parse(JSON.stringify(snapshot).split(receipt.executionArtifactRoot)
    .join("$ARTIFACT_ROOT"));
  const durableRun = { dispatchId: run.dispatch_id, version: run.version, fingerprint: run.fingerprint,
    state: run.state, normalizedSnapshot };
  const expectedEmbeddedEvidence = { ...receipt.executionEvidence, sqliteFiles, sqliteSha256, sqliteHex,
    durableRun, durableRunSha256: sha256(Buffer.from(JSON.stringify(durableRun))), events, fixture };
  const expectedAssertions = { ...coreAssertions, durableEvidenceEmbedded: true,
    selfContainedEvidenceEmbedded: true, externalArtifactsExcludedFromClaim: true };
  if (JSON.stringify(embedded) !== JSON.stringify(expectedEmbeddedEvidence)
    || JSON.stringify(receipt.assertions) !== JSON.stringify(expectedAssertions)) {
    throw new Error("sealed receipt evidence does not match its self-contained durable snapshot");
  }
  assertChildMatchesDescriptor(receiptParentFd, basename(receiptPath), receiptIdentity, "file");
  assertPathMatchesDescriptor(receiptParentPath, receiptParentIdentity, "directory");
  if (expectedArtifactRoot.startsWith(".agents/reviews/")) {
    if (!evidenceCommit) throw new Error("tracked receipt verification requires an immutable evidence commit");
    assertTrackedReceipt(repositoryRoot, evidenceCommit, receiptPath, receiptBytes);
  }
  return receipt;
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
