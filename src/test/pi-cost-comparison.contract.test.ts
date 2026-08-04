import { describe, expect, it } from "vitest";
import { actorReceiptsToPiCostRows, analyzePiCostComparison, type PiCostArmEvidence,
  type PiCostComparisonEvidence } from "../main/benchmark/pi-cost-comparison.js";
import { attestPiCostEvidence, makePiCostAttestationVerifier, piCostIntegrityKeyId,
  verifyPiCostEvidenceAttestation, type PiCostAttestationAuthority } from "../main/adapters/pi-cost-attestation.js";
import type { ActorReceipt } from "../main/domain/issue-orchestration.js";

const TEST_KEY = "test-only-pi-cost-attestation-key-0000000000000000";
const AUTHORITY: PiCostAttestationAuthority = { integrityKey: TEST_KEY, expectedKeyId: piCostIntegrityKeyId(TEST_KEY) };
const VERIFY = makePiCostAttestationVerifier(AUTHORITY);
const TRUSTED_MODULES = ["adapters/pi-cost-attestation.js", "benchmark/pi-cost-comparison.js"];
const TRUSTED_DIGESTS = Object.fromEntries(TRUSTED_MODULES.map((name, index) =>
  [name, `sha256:${String(index + 1).repeat(64)}`]));
const TRUSTED_CLOSURE_DIGEST = `sha256:${"f".repeat(64)}`;

function arm(name: "candidate" | "control", cost: number): PiCostArmEvidence {
  const model = name === "candidate" ? "deepseek-v4-flash" : "grok-4.3";
  const actorExecutionId = `${name}-actor-1`;
  const customerCostDecimal = cost.toFixed(8); const gatewayRequestId = `gateway-${name}`;
  const receipt = { executionId: `${name}-call-1`, actorExecutionId, gatewayRequestId, priceVersionId: `price-${name}`,
    source: "gateway_versioned_customer_billing" as const, settlementStatus: "settled", role: "tester", provider: "naia", model,
    inputTokens: 100, outputTokens: 20, customerCostDecimal, customerCostUsd: cost };
  return { taskDigest: "sha256:task", status: "completed",
    checkpoint: { beforeCloseDigest: "sha256:baseline", afterOpenDigest: "sha256:baseline" },
    scorerId: "deterministic-file-and-git-checks",
    checks: [{ name: "file-content", pass: true }, { name: "changed-files", pass: true }],
    changedFiles: ["src/answer.js"],
    actorAttempts: [{ executionId: actorExecutionId, role: "tester", provider: "naia", model }],
    calls: [{ executionId: `${name}-call-1`, actorExecutionId, role: "tester", provider: "naia", model, inputTokens: 100, outputTokens: 20 }],
    receipts: [receipt],
    sourceAudit: { journalHeads: [{ executionId: actorExecutionId, headDigest: `head-${name}`, entryCount: 1 }],
      journalReceipts: [{ ...receipt, journalEntryDigest: `entry-${name}`, ledgerReceiptDigest: `digest-${name}` }],
      gatewayLedger: [{ requestId: gatewayRequestId, status: "settled", actualCostDecimal: customerCostDecimal,
        actualInputTokens: 100, actualOutputTokens: 20, receiptDigest: `digest-${name}` }],
      gatewayBudget: { gatewayCalls: 1, activeReservations: 0, chargedUsdDecimal: customerCostDecimal,
        chargedInputTokens: 100, chargedOutputTokens: 20 } },
    localBudget: { paidCalls: 1, activeReservations: 0 } };
}

function comparison(): PiCostComparisonEvidence { const candidate = arm("candidate", 0.05); const control = arm("control", 0.1);
  const unsigned = { schemaVersion: 2 as const, benchmarkId: "paired", taskDigest: "sha256:task",
  baselineDigest: "sha256:baseline",
  minimumSavingsBasisPoints: 1000,
  routePolicy: { candidate: { provider: "naia", roleModels: { tester: "deepseek-v4-flash" } },
    control: { provider: "naia", roleModels: { tester: "grok-4.3" } } },
  expectedRoleCounts: { tester: 1 },
  qualityPolicy: { scorerId: "deterministic-file-and-git-checks",
    requiredChecks: ["file-content", "changed-files"], allowedChangedFiles: ["src/answer.js"] },
  budgetPolicy: { maximumCombinedActorAttempts: 2, maximumCombinedGatewayCalls: 2, maximumCombinedUsdDecimal: "0.50000000",
    maximumInputTokens: 1000, maximumOutputTokens: 1000 },
  priceVersionPolicy: { "deepseek-v4-flash": "price-candidate", "grok-4.3": "price-control" },
  trustedRuntimeModules: [...TRUSTED_MODULES], trustedRuntimeDigests: { ...TRUSTED_DIGESTS },
  trustedRuntimeClosureDigest: TRUSTED_CLOSURE_DIGEST,
  candidate, control, sharedGatewayLedger: combinedLedger(candidate, control) };
  return { ...unsigned, attestation: attestPiCostEvidence(unsigned, AUTHORITY) }; }

function resign(value: PiCostComparisonEvidence): PiCostComparisonEvidence {
  const { attestation: _prior, ...unsigned } = value;
  const finalized = { ...unsigned, sharedGatewayLedger: combinedLedger(unsigned.candidate, unsigned.control) };
  return { ...finalized, attestation: attestPiCostEvidence(finalized, AUTHORITY) };
}

function combinedLedger(candidate: PiCostArmEvidence, control: PiCostArmEvidence): PiCostComparisonEvidence["sharedGatewayLedger"] {
  const rows = [...candidate.sourceAudit.gatewayLedger, ...control.sourceAudit.gatewayLedger];
  let units = 0n; let input = 0; let output = 0; let active = 0;
  for (const row of rows) {
    if (row.status === "active") { active += 1; continue; }
    units += BigInt(row.actualCostDecimal!.replace(".", "")); input += row.actualInputTokens!; output += row.actualOutputTokens!;
  }
  const decimal = units.toString().padStart(9, "0");
  return { rows, snapshot: { gatewayCalls: rows.length, activeReservations: active,
    chargedUsdDecimal: `${decimal.slice(0, -8)}.${decimal.slice(-8)}`,
    chargedInputTokens: input, chargedOutputTokens: output } };
}

describe("Pi paid cost comparison contract", () => {
  it("canonicalizes object-key order and rejects malformed integrity authorities", () => {
    const first = { z: [1, true], a: { y: "value", x: null } };
    const reordered = { a: { x: null, y: "value" }, z: [1, true] };
    const attestation = attestPiCostEvidence(first, AUTHORITY);
    expect(verifyPiCostEvidenceAttestation(reordered, attestation, AUTHORITY)).toEqual([]);
    expect(() => piCostIntegrityKeyId("short")).toThrow(/at least 32 bytes/u);
    expect(verifyPiCostEvidenceAttestation({ value: Number.NaN }, attestation, AUTHORITY))
      .toEqual(["benchmark evidence cannot be canonicalized"]);
  });

  it("separates one actor attempt from each nested tool-loop gateway request", () => {
    const actor: ActorReceipt = { role: "worker", workerRole: "implementer", provider: "naia", model: "grok-4.3",
      sessionId: "session", executionId: "actor-execution", idempotencyKey: "step", tokenCountsAvailable: true,
      inputTokens: 13, cachedInputTokens: 2, outputTokens: 3, latencyMs: 1,
      cost: { state: "measured", usd: 0.03, source: "gateway_versioned_customer_billing" },
      gatewayBillingReceipts: [1, 2].map((index) => ({ source: "gateway_versioned_customer_billing",
        executionId: "actor-execution", localRequestId: `actor-execution:call:${index}`,
        gatewayRequestId: `gateway-${index}`, gatewayAttempt: 1, provider: "naia", model: "grok-4.3",
        inputTokens: index === 1 ? 5 : 8, cachedInputTokens: index === 1 ? 2 : 0,
        outputTokens: index === 1 ? 1 : 2, totalTokens: index === 1 ? 8 : 10,
        customerCostDecimal: index === 1 ? "0.01000000" : "0.02000000",
        customerCostUsd: index === 1 ? 0.01 : 0.02, priceVersionId: "price-grok",
        currency: "USD", settlementStatus: "settled" })) };
    expect(actorReceiptsToPiCostRows([actor])).toMatchObject({
      actorAttempts: [{ executionId: "actor-execution", role: "implementer" }],
      calls: [{ executionId: "actor-execution:call:1", actorExecutionId: "actor-execution", inputTokens: 7 },
        { executionId: "actor-execution:call:2", actorExecutionId: "actor-execution", inputTokens: 8 }],
      receipts: [{ gatewayRequestId: "gateway-1" }, { gatewayRequestId: "gateway-2" }],
    });
  });

  it("permits the scoped claim only for complete externally keyed evidence", () => {
    expect(analyzePiCostComparison(comparison(), VERIFY)).toMatchObject({ status: "verified",
      structuralOutcome: "candidate_lower_cost", costEfficiencyClaimAllowed: true,
      qualityNonInferior: true, costImproved: true, savingsRatio: 0.5,
      problems: [], arms: { candidate: { costUsdDecimal: "0.05000000" }, control: { costUsdDecimal: "0.10000000" } } });
  });

  it.each([
    ["missing authority", undefined],
    ["wrong key", { integrityKey: "wrong-test-key-0000000000000000000000000000", expectedKeyId: AUTHORITY.expectedKeyId }],
  ])("rejects %s", (_name, authority) => {
    const verifier = authority ? makePiCostAttestationVerifier(authority) : undefined;
    expect(analyzePiCostComparison(comparison(), verifier)).toMatchObject({ status: "unavailable",
      costEfficiencyClaimAllowed: false });
  });

  it("rejects post-attestation tampering and an unpinned key identity", () => {
    const changed: any = comparison(); changed.candidate.receipts[0].customerCostDecimal = "0.01000000";
    expect(analyzePiCostComparison(changed, VERIFY)).toMatchObject({ status: "unavailable" });
    const wrongIdentity: any = comparison(); wrongIdentity.attestation.keyId = `sha256:${"0".repeat(64)}`;
    expect(analyzePiCostComparison(wrongIdentity, VERIFY)).toMatchObject({ status: "unavailable" });
  });

  it.each([
    ["missing receipt", (value: any) => value.candidate.receipts.splice(0)],
    ["estimated source", (value: any) => { value.candidate.receipts[0].source = "pi_catalog"; }],
    ["unsettled", (value: any) => { value.candidate.receipts[0].settlementStatus = "pending"; }],
    ["missing correlation", (value: any) => { delete value.candidate.receipts[0].gatewayRequestId; }],
    ["price version missing", (value: any) => { delete value.candidate.receipts[0].priceVersionId; }],
    ["price version drift", (value: any) => { value.candidate.receipts[0].priceVersionId = "other-price"; }],
    ["route drift", (value: any) => { value.candidate.receipts[0].model = "other"; }],
    ["undeclared route", (value: any) => { value.candidate.calls[0].model = "other"; value.candidate.receipts[0].model = "other"; }],
    ["provider drift", (value: any) => { value.candidate.calls[0].provider = "other"; value.candidate.receipts[0].provider = "other"; }],
    ["role drift", (value: any) => { value.candidate.calls[0].role = "implementer"; value.candidate.receipts[0].role = "implementer"; }],
    ["token drift", (value: any) => { value.candidate.receipts[0].inputTokens += 1; }],
    ["extra receipt", (value: any) => { value.candidate.receipts.push({ ...value.candidate.receipts[0], executionId: "foreign" }); }],
    ["active reservation", (value: any) => { value.candidate.localBudget.activeReservations = 1; }],
    ["shared ledger omission", (value: any) => { value.sharedGatewayLedger.rows.splice(0, 1); }],
    ["trusted runtime drift", (value: any) => { value.trustedRuntimeDigests[TRUSTED_MODULES[0]] = "changed"; }],
    ["checkpoint absent", (value: any) => { value.candidate.checkpoint.afterOpenDigest = "different"; }],
    ["different arm baseline", (value: any) => { value.control.checkpoint.beforeCloseDigest = "other"; value.control.checkpoint.afterOpenDigest = "other"; }],
    ["unpinned baseline", (value: any) => { value.baselineDigest = null; }],
    ["verification failed", (value: any) => { value.candidate.checks[0].pass = false; }],
    ["scorer drift", (value: any) => { value.candidate.scorerId = "model-judge"; }],
    ["changed-file drift", (value: any) => { value.candidate.changedFiles.push("README.md"); }],
    ["extra actor attempt", (value: any) => { value.control.actorAttempts.push({ ...value.control.actorAttempts[0], executionId: "control-actor-2" }); }],
    ["role denominator", (value: any) => { value.expectedRoleCounts.tester = 2; }],
    ["shared execution id", (value: any) => { value.control.calls[0].executionId = value.candidate.calls[0].executionId; value.control.receipts[0].executionId = value.candidate.calls[0].executionId; }],
    ["shared actor execution id", (value: any) => { value.control.actorAttempts[0].executionId = value.candidate.actorAttempts[0].executionId; value.control.calls[0].actorExecutionId = value.candidate.actorAttempts[0].executionId; value.control.receipts[0].actorExecutionId = value.candidate.actorAttempts[0].executionId; }],
    ["shared gateway id", (value: any) => { value.control.receipts[0].gatewayRequestId = value.candidate.receipts[0].gatewayRequestId; }],
    ["duplicate gateway id", (value: any) => { value.candidate.receipts.push({ ...value.candidate.receipts[0], executionId: "candidate-call-2" }); value.candidate.calls.push({ ...value.candidate.calls[0], executionId: "candidate-call-2" }); value.budgetPolicy.maximumCombinedGatewayCalls = 3; }],
    ["USD cap", (value: any) => { value.budgetPolicy.maximumCombinedUsdDecimal = "0.01000000"; }],
    ["input cap", (value: any) => { value.budgetPolicy.maximumInputTokens = 10; }],
    ["output cap", (value: any) => { value.budgetPolicy.maximumOutputTokens = 10; }],
    ["malformed checks", (value: any) => { value.candidate.checks = null; }],
    ["malformed changed files", (value: any) => { value.candidate.changedFiles = "src/answer.js"; }],
    ["malformed calls", (value: any) => { value.candidate.calls = {}; }],
    ["malformed actor attempts", (value: any) => { value.candidate.actorAttempts = {}; }],
    ["malformed role counts", (value: any) => { value.expectedRoleCounts = "tester"; }],
    ["malformed price policy", (value: any) => { value.priceVersionPolicy = { "deepseek-v4-flash": null }; }],
    ["malformed required checks policy", (value: any) => { value.qualityPolicy.requiredChecks = null; }],
    ["malformed changed-files policy", (value: any) => { value.qualityPolicy.allowedChangedFiles = null; }],
  ])("fails closed for %s", (_name, mutate) => {
    const value: any = comparison(); mutate(value);
    expect(analyzePiCostComparison(value, VERIFY)).toMatchObject({ status: "unavailable", costEfficiencyClaimAllowed: false });
  });

  it("reports a structurally worse candidate without making a claim", () => {
    const value = resign({ ...comparison(), candidate: arm("candidate", 0.11) });
    expect(analyzePiCostComparison(value, VERIFY)).toMatchObject({ status: "verified",
      structuralOutcome: "not_better", costEfficiencyClaimAllowed: false });
  });

  it("uses exact integer arithmetic at and immediately above the savings threshold", () => {
    const base: any = comparison(); base.budgetPolicy.maximumCombinedUsdDecimal = "0.60000000";
    const boundary = resign({ ...base, candidate: arm("candidate", 0.27), control: arm("control", 0.30) });
    expect(analyzePiCostComparison(boundary, VERIFY)).toMatchObject({ status: "verified", costImproved: true,
      savingsUsdDecimal: "0.03000000" });
    const adjacent = resign({ ...base, candidate: arm("candidate", 0.27000001), control: arm("control", 0.30) });
    expect(analyzePiCostComparison(adjacent, VERIFY)).toMatchObject({ status: "verified", costImproved: false,
      savingsUsdDecimal: "0.02999999" });
  });

  it("rejects an omitted call and receipt even when the reduced evidence is re-attested", () => {
    const value: any = comparison();
    const secondReceipt = { ...value.candidate.receipts[0], executionId: "candidate-call-2",
      gatewayRequestId: "gateway-candidate-2", customerCostDecimal: "0.01000000", customerCostUsd: 0.01 };
    value.candidate.calls.push({ ...value.candidate.calls[0], executionId: "candidate-call-2" });
    value.candidate.receipts.push(secondReceipt);
    value.candidate.sourceAudit.journalHeads[0].entryCount = 2;
    value.candidate.sourceAudit.journalReceipts.push({ ...secondReceipt,
      journalEntryDigest: "entry-candidate-2", ledgerReceiptDigest: "digest-candidate-2" });
    value.candidate.sourceAudit.gatewayLedger.push({ requestId: "gateway-candidate-2", status: "settled",
      actualCostDecimal: "0.01000000", actualInputTokens: 100, actualOutputTokens: 20,
      receiptDigest: "digest-candidate-2" });
    value.candidate.sourceAudit.gatewayBudget = { gatewayCalls: 2, activeReservations: 0,
      chargedUsdDecimal: "0.06000000", chargedInputTokens: 200, chargedOutputTokens: 40 };
    value.budgetPolicy.maximumCombinedGatewayCalls = 3;
    // Simulates the evidence producer dropping a costly pair while the independently captured sources remain complete.
    value.candidate.calls.splice(1, 1); value.candidate.receipts.splice(1, 1);
    expect(analyzePiCostComparison(resign(value), VERIFY)).toMatchObject({ status: "unavailable",
      costEfficiencyClaimAllowed: false, problems: expect.arrayContaining([
        expect.stringContaining("preserved journals"), expect.stringContaining("gateway ledger")]) });
  });

  it("keeps differing tool-loop gateway-call counts in the cost result while actor topology stays fixed", () => {
    const value: any = comparison();
    value.candidate.calls.push({ ...value.candidate.calls[0], executionId: "candidate-call-2", inputTokens: 10, outputTokens: 2 });
    value.candidate.receipts.push({ ...value.candidate.receipts[0], executionId: "candidate-call-2",
      gatewayRequestId: "gateway-candidate-2", inputTokens: 10, outputTokens: 2,
      customerCostDecimal: "0.01000000", customerCostUsd: 0.01 });
    value.candidate.sourceAudit.journalHeads[0].entryCount = 2;
    value.candidate.sourceAudit.journalReceipts.push({ ...value.candidate.receipts[1],
      journalEntryDigest: "entry-candidate-2", ledgerReceiptDigest: "digest-candidate-2" });
    value.candidate.sourceAudit.gatewayLedger.push({ requestId: "gateway-candidate-2", status: "settled",
      actualCostDecimal: "0.01000000", actualInputTokens: 10, actualOutputTokens: 2,
      receiptDigest: "digest-candidate-2" });
    value.candidate.sourceAudit.gatewayBudget = { gatewayCalls: 2, activeReservations: 0,
      chargedUsdDecimal: "0.06000000", chargedInputTokens: 110, chargedOutputTokens: 22 };
    value.budgetPolicy.maximumCombinedGatewayCalls = 3;
    const signed = resign(value);
    expect(analyzePiCostComparison(signed, VERIFY)).toMatchObject({ status: "verified", structuralOutcome: "candidate_lower_cost",
      arms: { candidate: { actorAttemptCount: 1, gatewayCallCount: 2 },
        control: { actorAttemptCount: 1, gatewayCallCount: 1 } } });
  });

  it("never throws for malformed top-level evidence", () => {
    for (const value of [null, [], {}, { schemaVersion: 2, candidate: { checks: null } }]) {
      expect(() => analyzePiCostComparison(value)).not.toThrow();
      expect(analyzePiCostComparison(value)).toMatchObject({ status: "unavailable",
        structuralOutcome: "invalid", costEfficiencyClaimAllowed: false });
    }
  });

  it("fails closed instead of throwing for malformed nested ledger rows", () => {
    const value: any = comparison(); value.candidate.sourceAudit.gatewayLedger[0] = null;
    value.sharedGatewayLedger.rows[0] = null;
    const { attestation: _prior, ...unsigned } = value;
    const signed = { ...unsigned, attestation: attestPiCostEvidence(unsigned, AUTHORITY) };
    expect(() => analyzePiCostComparison(signed, VERIFY)).not.toThrow();
    expect(analyzePiCostComparison(signed, VERIFY)).toMatchObject({ status: "unavailable",
      costEfficiencyClaimAllowed: false });
  });

  it.each([undefined, null, "models"])("fails closed for malformed nested roleModels: %s", (roleModels) => {
    const value: any = comparison(); value.routePolicy.candidate = { provider: "naia" };
    if (roleModels !== undefined) value.routePolicy.candidate.roleModels = roleModels;
    const { attestation: _prior, ...unsigned } = value;
    const signed = { ...unsigned, attestation: attestPiCostEvidence(unsigned, AUTHORITY) };
    expect(() => analyzePiCostComparison(signed, VERIFY)).not.toThrow();
    expect(analyzePiCostComparison(signed, VERIFY)).toMatchObject({ status: "unavailable",
      costEfficiencyClaimAllowed: false });
  });
});
