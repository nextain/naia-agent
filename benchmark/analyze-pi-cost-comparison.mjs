#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const contract = JSON.parse(readFileSync(new URL("./orchestration/pi-cost-comparison.json", import.meta.url), "utf8"));
const actualDigest = `sha256:${createHash("sha256").update(JSON.stringify(contract.task)).digest("hex")}`;
if (actualDigest !== contract.taskDigest) throw new Error("frozen benchmark task digest mismatch");
const evidenceIndex = process.argv.indexOf("--evidence");
if (evidenceIndex < 0 || !process.argv[evidenceIndex + 1]) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "unavailable", paidCalls: 0, costEfficiencyClaimAllowed: false,
    reason: "exact paired execution evidence was not supplied",
    requiredReceiptSource: contract.receiptAuthority.source,
    note: "Pi catalog estimates and account time-window deltas cannot prove request-bound customer cost" }, null, 2)}\n`);
  process.exit(0);
}
const evidence = JSON.parse(readFileSync(resolve(process.argv[evidenceIndex + 1]), "utf8"));
if (evidence.benchmarkId !== contract.benchmarkId || evidence.taskDigest !== contract.taskDigest) {
  throw new Error("evidence is not bound to the frozen benchmark contract");
}
evidence.minimumSavingsRatio = contract.minimumSavingsRatio;
evidence.baselineDigest = contract.baselineDigest;
evidence.routePolicy = contract.routePolicy;
evidence.expectedRoleCounts = contract.expectedRoleCounts;
evidence.qualityPolicy = { scorerId: contract.quality.scorerId,
  requiredChecks: contract.quality.requiredChecks, allowedChangedFiles: contract.quality.allowedChangedFiles };
evidence.budgetPolicy = contract.budget;
evidence.priceVersionPolicy = contract.receiptAuthority.priceVersionByModel;
const { analyzePiCostComparison } = await import("../dist/main/benchmark/pi-cost-comparison.js");
const result = analyzePiCostComparison(evidence);
process.stdout.write(`${JSON.stringify({ ...result, contract: { taskDigest: contract.taskDigest,
    maximumCombinedActorAttempts: contract.budget.maximumCombinedActorAttempts,
    maximumCombinedGatewayCalls: contract.budget.maximumCombinedGatewayCalls,
  maximumCombinedUsd: contract.budget.maximumCombinedUsd } }, null, 2)}\n`);
if (result.status === "unavailable") process.exitCode = 2;
