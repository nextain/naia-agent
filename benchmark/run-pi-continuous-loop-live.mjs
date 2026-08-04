#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const benchmarkId = "pi-loop-live-smoke-v1";
const outputIndex = process.argv.indexOf("--output");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) throw new Error("--output requires a path");
const outputPath = outputArgument ? resolve(outputArgument) : undefined;
const artifactRoot = outputPath ? `${outputPath}.artifacts` : undefined;
const confirmed = process.argv.includes("--confirm-one-paid-call") && process.env.NAIA_PI_LIVE_CONFIRM === "1";
const key = (process.env.NAIA_API_KEY ?? process.env.NAIA_ANYLLM_API_KEY)?.trim();
const pathOccupied = Boolean(outputPath && (existsSync(outputPath) || existsSync(artifactRoot)));
const reason = pathOccupied ? "paid smoke output or artifact path already exists"
  : !confirmed ? "explicit one-paid-call confirmation missing"
  : !key ? "Naia credential unavailable"
  : !outputPath ? "durable --output path is required for paid smoke"
  : undefined;
if (reason) {
  const payload = { schemaVersion: 1, benchmarkId, status: "unavailable", paidCalls: 0,
    gatewayCalls: 0, reason, costEfficiencyClaimAllowed: false };
  if (pathOccupied) printPayload(payload); else emitPreflight(payload);
  process.exit(0);
}

const root = artifactRoot;
claimOutput({ schemaVersion: 1, benchmarkId, status: "running", paidCalls: 0,
  gatewayCalls: 0, artifactRoot });
try { mkdirSync(root, { recursive: false, mode: 0o700 }); }
catch (error) {
  writePayload({ schemaVersion: 1, benchmarkId, status: "unavailable", paidCalls: 0,
    gatewayCalls: 0, artifactRoot,
    reason: `paid smoke artifact reservation failed: ${error instanceof Error ? error.message : String(error)}`,
    costEfficiencyClaimAllowed: false });
  process.exit(2);
}
const dist = new URL("../dist/main/", import.meta.url);
const gatewayBudget = { path: join(root, "gateway-requests.db"), policy: { maxGatewayCalls: 1,
  maxUsd: 0.05, maxInputTokens: 4_000, maxOutputTokens: 256,
  requestAllowance: { reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 256 } } };
let budget; let billing;
try {
  const { makePiSubAgent } = await import(new URL("adapters/subagent-pi.js", dist).href);
  const { SqlitePaidCallBudget } = await import(new URL("adapters/sqlite-paid-call-budget.js", dist).href);
  billing = await import(new URL("adapters/naia-pi-versioned-billing.js", dist).href);
  billing.initializeGatewayRequestBudget(gatewayBudget.path, gatewayBudget.policy);
  budget = new SqlitePaidCallBudget(join(root, "budget.db"),
    { maxPaidCalls: 1, maxUsd: 0.05, maxInputTokens: 4_000, maxOutputTokens: 256 });
  const idempotencyKey = "pi-loop-live:analysis:1";
  budget.reserve({ idempotencyKey, expectedProvider: "naia", expectedModel: "deepseek-v4-pro",
    reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 256 });
  const session = makePiSubAgent({ provider: "naia", model: "deepseek-v4-pro", noTools: true,
    maxOutputTokens: 256, env: process.env, piConfigDir: join(root, "pi"), gatewayBudget })
    .spawn({ prompt: "Return exactly this JSON and nothing else: {\"status\":\"ok\"}", workdir: root,
      model: "deepseek-v4-pro", filesystemAccess: "read_only" });
  let evidence; let ok = false;
  for await (const event of session.events) {
    if (event.kind === "model_evidence") evidence = event.evidence;
    if (event.kind === "session_end") { evidence = event.evidence ?? evidence; ok = event.ok; }
  }
  if (!ok || !evidence?.usageAvailable || evidence.measuredCostUsd === undefined
    || !evidence.sessionId || !evidence.executionId || !evidence.gatewayBillingReceipts?.length) {
    throw new Error("complete request-correlated gateway billing evidence unavailable");
  }
  const receipt = { role: "worker", provider: evidence.provider, model: evidence.selectedModel,
    sessionId: evidence.sessionId, executionId: evidence.executionId, idempotencyKey,
    tokenCountsAvailable: true, inputTokens: evidence.inputTokens, cachedInputTokens: evidence.cachedInputTokens ?? 0,
    outputTokens: evidence.outputTokens, latencyMs: 0, modelEvidenceSource: "provider_reported",
    gatewayBillingReceipts: evidence.gatewayBillingReceipts,
    cost: { state: "measured", usd: evidence.measuredCostUsd, source: "gateway_versioned_customer_billing" } };
  budget.settle(idempotencyKey, receipt);
  writePayload({ schemaVersion: 1, benchmarkId, status: "observed", paidCalls: 1, gatewayCalls: 1,
    provider: receipt.provider, model: receipt.model, usage: {
      inputTokens: receipt.inputTokens, cachedInputTokens: receipt.cachedInputTokens, outputTokens: receipt.outputTokens },
    customerCostUsd: receipt.cost.usd,
    gatewayReceipts: receipt.gatewayBillingReceipts.map(({ localRequestId, gatewayRequestId, gatewayAttempt,
      priceVersionId, settlementStatus, customerCostDecimal }) => ({ localRequestId, gatewayRequestId,
      gatewayAttempt, priceVersionId, settlementStatus, customerCostDecimal })),
    attestationStatus: "unavailable", artifactRoot, budget: budget.snapshot(), costEfficiencyClaimAllowed: false });
} catch (error) {
  let requestBudget;
  try { requestBudget = billing?.readGatewayRequestBudget(gatewayBudget.path, gatewayBudget.policy); }
  catch { /* setup failed before a readable request ledger existed */ }
  writePayload({ schemaVersion: 1, benchmarkId, status: "unavailable",
    paidCalls: budget?.snapshot().paidCalls ?? 0, gatewayCalls: requestBudget?.gatewayCalls ?? 0,
    budget: budget?.snapshot(), ...(requestBudget ? { gatewayBudget: requestBudget } : {}), artifactRoot,
    reason: error instanceof Error ? error.message : String(error), costEfficiencyClaimAllowed: false });
  process.exitCode = 2;
} finally {
  try { budget?.close(); } catch { /* preserve the benchmark result/error */ }
}

function writePayload(payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  writeFileSync(1, serialized);
}
function printPayload(payload) { writeFileSync(1, `${JSON.stringify(payload, null, 2)}\n`); }
function claimOutput(payload) {
  if (!outputPath) throw new Error("durable output path unavailable");
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
function emitPreflight(payload) {
  if (!outputPath) { printPayload(payload); return; }
  try { claimOutput(payload); printPayload(payload); } catch { printPayload(payload); }
}
