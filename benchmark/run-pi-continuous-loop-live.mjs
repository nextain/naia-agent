#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const confirmed = process.argv.includes("--confirm-one-paid-call") && process.env.NAIA_PI_LIVE_CONFIRM === "1";
const key = (process.env.NAIA_API_KEY ?? process.env.NAIA_ANYLLM_API_KEY)?.trim();
if (!confirmed || !key) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, benchmarkId: "pi-loop-live-smoke-v1",
    status: "unavailable", paidCalls: 0,
    reason: !confirmed ? "explicit one-paid-call confirmation missing" : "Naia credential unavailable",
    costEfficiencyClaimAllowed: false }, null, 2)}\n`);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "naia-pi-live-"));
let budget;
try {
  const dist = new URL("../dist/main/", import.meta.url);
  const { makePiSubAgent } = await import(new URL("adapters/subagent-pi.js", dist).href);
  const { SqlitePaidCallBudget } = await import(new URL("adapters/sqlite-paid-call-budget.js", dist).href);
  budget = new SqlitePaidCallBudget(join(root, "budget.db"),
    { maxPaidCalls: 1, maxUsd: 0.05, maxInputTokens: 4_000, maxOutputTokens: 256 });
  const idempotencyKey = "pi-loop-live:analysis:1";
  budget.reserve({ idempotencyKey, expectedProvider: "naia", expectedModel: "deepseek-v4-pro",
    reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 256 });
  const session = makePiSubAgent({ provider: "naia", model: "deepseek-v4-pro", noTools: true,
    maxOutputTokens: 256, env: process.env, piConfigDir: join(root, "pi") })
    .spawn({ prompt: "Return exactly this JSON and nothing else: {\"status\":\"ok\"}", workdir: root,
      model: "deepseek-v4-pro", filesystemAccess: "read_only" });
  let evidence; let ok = false;
  for await (const event of session.events) {
    if (event.kind === "model_evidence") evidence = event.evidence;
    if (event.kind === "session_end") { evidence = event.evidence ?? evidence; ok = event.ok; }
  }
  if (!ok || !evidence?.usageAvailable || evidence.piEstimatedCost === undefined
    || !evidence.sessionId || !evidence.executionId) throw new Error("complete Pi live evidence unavailable");
  const receipt = { role: "worker", provider: evidence.provider, model: evidence.selectedModel,
    sessionId: evidence.sessionId, executionId: evidence.executionId, idempotencyKey,
    tokenCountsAvailable: true, inputTokens: evidence.inputTokens, cachedInputTokens: evidence.cachedInputTokens ?? 0,
    outputTokens: evidence.outputTokens, latencyMs: 0, estimatedCostUsd: evidence.piEstimatedCost,
    estimatedCostSource: "pi_catalog", modelEvidenceSource: "provider_reported",
    cost: { state: "unavailable", reason: "Pi catalog-priced estimate; not Azure invoice evidence" } };
  budget.settle(idempotencyKey, receipt);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, benchmarkId: "pi-loop-live-smoke-v1", status: "observed",
    paidCalls: 1, provider: receipt.provider, model: receipt.model, usage: {
      inputTokens: receipt.inputTokens, cachedInputTokens: receipt.cachedInputTokens, outputTokens: receipt.outputTokens },
    estimatedCostUsd: receipt.estimatedCostUsd, providerInvoiceCost: "unavailable",
    budget: budget.snapshot(), costEfficiencyClaimAllowed: false }, null, 2)}\n`);
} finally {
  try { budget?.close(); } catch { /* preserve the benchmark result/error */ }
  rmSync(root, { recursive: true, force: true });
}
