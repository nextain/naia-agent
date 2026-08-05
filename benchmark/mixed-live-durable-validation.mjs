import { join } from "node:path";
import { sha256 } from "./mixed-live-seal-utils.mjs";

export function validateDurableRun(run, snapshot, events, runId, artifactBindingPath, executionArtifactRoot) {
  const expectedIssueId = sha256(Buffer.from(`${runId}\0${artifactBindingPath}`));
  if (run.dispatch_id !== `${runId}:dispatch:1` || run.dispatch_id !== snapshot.dispatchId
    || snapshot.issueId !== expectedIssueId || snapshot.allocation?.workspacePath !== join(executionArtifactRoot, "fixture")
    || snapshot.allocation?.worktreePath !== join(executionArtifactRoot, "fixture")) {
    throw new Error("durable run binding does not match the execution run ID and artifact path");
  }
  if (run.version !== snapshot.version || run.fingerprint !== snapshot.fingerprint
    || run.state !== snapshot.state || run.state !== "completed"
    || events.length !== snapshot.version || snapshot.version !== snapshot.receipts.length * 2 + 1) {
    throw new Error("SQLite run columns, snapshot, and event cardinality are inconsistent");
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]; const sequence = index + 1;
    const expectedType = sequence === 1 ? "team_created" : sequence === events.length ? "team_completed"
      : sequence % 2 === 0 ? "role_claimed" : "role_acknowledged";
    const expectedState = sequence === events.length ? "completed" : sequence % 2 === 0 ? "running" : "ready";
    if (event.dispatch_id !== snapshot.dispatchId || event.sequence !== sequence
      || event.event_type !== expectedType || event.state !== expectedState) {
      throw new Error("SQLite event history is inconsistent with the completed run");
    }
  }
}

export function validateDurableReceipts(snapshot, profile) {
  const sessions = new Set(); const executions = new Set();
  const allowedKeys = ["role", "workerRole", "agentProfileId", "agentKind", "provider", "model", "reasoningEffort",
    "sessionId", "executionId", "idempotencyKey", "sessionEvidenceSource", "tokenCountsAvailable", "inputTokens",
    "cachedInputTokens", "outputTokens", "latencyMs", "modelEvidenceSource", "cost"];
  for (let index = 0; index < snapshot.receipts.length; index += 1) {
    const value = snapshot.receipts[index]; const declared = profile.roles?.[value.workerRole];
    if (!value || value.role !== "worker" || !declared || value.agentProfileId !== declared.agentProfileId
      || value.idempotencyKey !== `${snapshot.dispatchId}:${value.workerRole}:${index + 1}`
      || !Number.isFinite(value.latencyMs) || value.latencyMs < 0
      || Object.keys(value).some((key) => !allowedKeys.includes(key))
      || sessions.has(value.sessionId) || executions.has(value.executionId)) {
      throw new Error("durable worker receipt invariants are inconsistent");
    }
    for (const tokens of [value.inputTokens, value.cachedInputTokens, value.outputTokens]) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("durable worker receipt accounting is invalid");
    }
    if (!value.tokenCountsAvailable && (value.inputTokens !== 0 || value.cachedInputTokens !== 0
      || value.outputTokens !== 0 || value.cost?.state === "measured")) {
      throw new Error("durable worker unavailable usage evidence is invalid");
    }
    if (value.cost?.state === "measured"
      ? !Number.isFinite(value.cost.usd) || value.cost.usd < 0 || !value.cost.source?.trim()
      : value.cost?.state !== "unavailable" || !value.cost.reason?.trim()) {
      throw new Error("durable worker receipt cost evidence is invalid");
    }
    sessions.add(value.sessionId); executions.add(value.executionId);
  }
}

export function validateOutcomeSchemas(snapshot) {
  if (!Array.isArray(snapshot.outcomes) || snapshot.outcomes.length !== snapshot.receipts.length) {
    throw new Error("durable outcome evidence is incomplete");
  }
  for (let index = 0; index < snapshot.outcomes.length; index += 1) {
    const outcome = snapshot.outcomes[index]; const codes = new Set();
    if (!outcome || outcome.version !== 1 || outcome.role !== snapshot.receipts[index].workerRole
      || typeof outcome.summary !== "string" || Buffer.byteLength(outcome.summary, "utf8") > 8 * 1024
      || !Array.isArray(outcome.findings) || outcome.findings.length > 32
      || Object.keys(outcome).some((key) => !["version", "role", "decision", "summary", "findings"].includes(key))) {
      throw new Error("durable outcome schema is invalid");
    }
    for (const finding of outcome.findings) {
      if (!finding || typeof finding.code !== "string" || !finding.code || finding.code.length > 80
        || codes.has(finding.code) || typeof finding.message !== "string"
        || Buffer.byteLength(finding.message, "utf8") > 2 * 1024
        || Object.keys(finding).some((key) => !["code", "message"].includes(key))) {
        throw new Error("durable outcome finding schema is invalid");
      }
      codes.add(finding.code);
    }
  }
}

export function projectReceipt(value) {
  return { workerRole: value.workerRole, agentKind: value.agentKind, provider: value.provider, model: value.model,
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}), sessionId: value.sessionId,
    sessionEvidenceSource: value.sessionEvidenceSource, modelEvidenceSource: value.modelEvidenceSource,
    executionId: value.executionId,
    tokenCountsAvailable: value.tokenCountsAvailable, inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens, outputTokens: value.outputTokens, cost: value.cost };
}

export function pickCoreAssertions(value) {
  return { exactArtifacts: value?.exactArtifacts, evidenceComplete: value?.evidenceComplete,
    mixedAppsObserved: value?.mixedAppsObserved, roleKinds: value?.roleKinds };
}
