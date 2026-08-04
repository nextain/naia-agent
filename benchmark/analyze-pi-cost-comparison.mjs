#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPiCostContract } from "./pi-cost-contract.mjs";

export async function runPiCostAnalyzerCli(argv, env = process.env, options = {}) {
  const contract = loadPiCostContract(argv,
    options.baseContract ?? new URL("./orchestration/pi-cost-comparison.json", import.meta.url));
  const actualDigest = `sha256:${createHash("sha256").update(JSON.stringify(contract.task)).digest("hex")}`;
  if (actualDigest !== contract.taskDigest) throw new Error("frozen benchmark task digest mismatch");
  const evidenceIndex = argv.indexOf("--evidence");
  if (evidenceIndex < 0 || !argv[evidenceIndex + 1]) {
    return { exitCode: 0, payload: { schemaVersion: contract.schemaVersion, benchmarkId: contract.benchmarkId,
    status: "unavailable", paidCalls: 0, costEfficiencyClaimAllowed: false,
    reason: "exact paired execution evidence was not supplied",
    requiredReceiptSource: contract.receiptAuthority.source,
    note: "Pi catalog estimates and account time-window deltas cannot prove request-bound customer cost" } };
  }
  const supplied = JSON.parse(readFileSync(resolve(argv[evidenceIndex + 1]), "utf8"));
  const evidence = supplied?.evidence && typeof supplied.evidence === "object" ? supplied.evidence : supplied;
  if (evidence.benchmarkId !== contract.benchmarkId || evidence.taskDigest !== contract.taskDigest
    || evidence.schemaVersion !== contract.schemaVersion || evidence.baselineDigest !== contract.baselineDigest
    || evidence.minimumSavingsBasisPoints !== contract.minimumSavingsBasisPoints
    || !sameJson(evidence.routePolicy, contract.routePolicy)
    || !sameJson(evidence.expectedRoleCounts, contract.expectedRoleCounts)
    || !sameJson(evidence.qualityPolicy, { scorerId: contract.quality.scorerId,
      requiredChecks: contract.quality.requiredChecks, allowedChangedFiles: contract.quality.allowedChangedFiles })
    || !sameJson(evidence.budgetPolicy, contract.budget)
    || evidence.trustedRuntimeModules?.length !== contract.trustedRuntimeClosure.fileCount
    || !contract.trustedRuntimeModules.every((name) => evidence.trustedRuntimeModules?.includes(name))
    || !contract.trustedRuntimeArtifacts.every((name) => evidence.trustedRuntimeModules?.includes(name))
    || !contract.trustedRuntimePackages.every((entry) => evidence.trustedRuntimeModules?.includes(`npm:${entry.name}/package.json`))
    || !contract.trustedRuntimeExecutables.every((name) => evidence.trustedRuntimeModules?.includes(`executable:${name}`))
    || evidence.trustedRuntimeClosureDigest !== contract.trustedRuntimeClosure.manifestDigest
    || !sameJson(evidence.executionAuthority, contract.executionAuthority)
    || !sameJson(evidence.priceVersionPolicy, contract.receiptAuthority.priceVersionByModel)) {
    throw new Error("evidence is not bound to the frozen benchmark contract");
  }
  const { analyzePiCostComparison } = await import("../dist/main/benchmark/pi-cost-comparison.js");
  const journalKey = env.NAIA_BENCHMARK_JOURNAL_KEY;
  const expectedKeyId = contract.receiptAuthority.authentication.harnessJournalKeyId;
  const authority = journalKey && typeof expectedKeyId === "string" && expectedKeyId
    ? { integrityKey: journalKey, expectedKeyId } : undefined;
  const attestationModule = authority ? await import("../dist/main/adapters/pi-cost-attestation.js") : undefined;
  const result = analyzePiCostComparison(evidence,
    authority ? attestationModule.makePiCostAttestationVerifier(authority) : undefined);
  return { exitCode: result.status === "unavailable" ? 2 : 0, payload: { ...result,
    contract: { taskDigest: contract.taskDigest,
      maximumCombinedActorAttempts: contract.budget.maximumCombinedActorAttempts,
      maximumCombinedGatewayCalls: contract.budget.maximumCombinedGatewayCalls,
      maximumCombinedUsdDecimal: contract.budget.maximumCombinedUsdDecimal } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = await runPiCostAnalyzerCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(outcome.payload, null, 2)}\n`);
  process.exitCode = outcome.exitCode;
}

function sameJson(left, right) { return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right)); }
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, sortJson(value[key])]));
  return value;
}
