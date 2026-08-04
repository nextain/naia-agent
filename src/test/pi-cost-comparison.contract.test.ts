import { describe, expect, it } from "vitest";
import { actorReceiptsToPiCostRows, analyzePiCostComparison, type PiCostArmEvidence,
  type PiCostComparisonEvidence } from "../main/benchmark/pi-cost-comparison.js";
import type { ActorReceipt } from "../main/domain/issue-orchestration.js";

function arm(name: "candidate" | "control", cost: number): PiCostArmEvidence {
  const model = name === "candidate" ? "deepseek-v4-pro" : "grok-4.3";
  const actorExecutionId = `${name}-actor-1`;
  return { taskDigest: "sha256:task", status: "completed",
    checkpoint: { beforeCloseDigest: "sha256:baseline", afterOpenDigest: "sha256:baseline" },
    scorerId: "deterministic-file-and-git-checks",
    checks: [{ name: "file-content", pass: true }, { name: "changed-files", pass: true }],
    changedFiles: ["src/answer.js"],
    actorAttempts: [{ executionId: actorExecutionId, role: "tester", provider: "naia", model }],
    calls: [{ executionId: `${name}-call-1`, actorExecutionId, role: "tester", provider: "naia", model, inputTokens: 100, outputTokens: 20 }],
    receipts: [{ executionId: `${name}-call-1`, actorExecutionId, gatewayRequestId: `gateway-${name}`, priceVersionId: `price-${name}`,
      source: "gateway_versioned_customer_billing", settlementStatus: "settled", role: "tester", provider: "naia", model,
      inputTokens: 100, outputTokens: 20, customerCostUsd: cost }],
    localBudget: { paidCalls: 1, activeReservations: 0 } };
}

function comparison(): PiCostComparisonEvidence { return { schemaVersion: 2, benchmarkId: "paired", taskDigest: "sha256:task",
  baselineDigest: "sha256:baseline",
  minimumSavingsRatio: 0.1,
  routePolicy: { candidate: { provider: "naia", roleModels: { tester: "deepseek-v4-pro" } },
    control: { provider: "naia", roleModels: { tester: "grok-4.3" } } },
  expectedRoleCounts: { tester: 1 },
  qualityPolicy: { scorerId: "deterministic-file-and-git-checks",
    requiredChecks: ["file-content", "changed-files"], allowedChangedFiles: ["src/answer.js"] },
  budgetPolicy: { maximumCombinedActorAttempts: 2, maximumCombinedGatewayCalls: 2, maximumCombinedUsd: 0.5,
    maximumInputTokens: 1000, maximumOutputTokens: 1000 },
  priceVersionPolicy: { "deepseek-v4-pro": "price-candidate", "grok-4.3": "price-control" },
  candidate: arm("candidate", 0.05), control: arm("control", 0.1) }; }

describe("Pi paid cost comparison contract", () => {
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

  it("reports a structural saving but cannot upgrade unsigned JSON to proof", () => {
    expect(analyzePiCostComparison(comparison())).toMatchObject({ status: "unavailable",
      structuralOutcome: "candidate_lower_cost", costEfficiencyClaimAllowed: false,
      qualityNonInferior: true, costImproved: true, savingsRatio: 0.5,
      problems: ["cryptographic gateway billing and harness-journal attestations are not implemented"] });
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
    ["USD cap", (value: any) => { value.budgetPolicy.maximumCombinedUsd = 0.01; }],
    ["input cap", (value: any) => { value.budgetPolicy.maximumInputTokens = 10; }],
    ["output cap", (value: any) => { value.budgetPolicy.maximumOutputTokens = 10; }],
    ["malformed checks", (value: any) => { value.candidate.checks = null; }],
    ["malformed changed files", (value: any) => { value.candidate.changedFiles = "src/answer.js"; }],
    ["malformed calls", (value: any) => { value.candidate.calls = {}; }],
    ["malformed actor attempts", (value: any) => { value.candidate.actorAttempts = {}; }],
    ["malformed role counts", (value: any) => { value.expectedRoleCounts = "tester"; }],
    ["malformed price policy", (value: any) => { value.priceVersionPolicy = { "deepseek-v4-pro": null }; }],
    ["malformed required checks policy", (value: any) => { value.qualityPolicy.requiredChecks = null; }],
    ["malformed changed-files policy", (value: any) => { value.qualityPolicy.allowedChangedFiles = null; }],
  ])("fails closed for %s", (_name, mutate) => {
    const value: any = comparison(); mutate(value);
    expect(analyzePiCostComparison(value)).toMatchObject({ status: "unavailable", costEfficiencyClaimAllowed: false });
  });

  it("reports a structurally worse candidate without making a claim", () => {
    const value = { ...comparison(), candidate: arm("candidate", 0.11) };
    expect(analyzePiCostComparison(value)).toMatchObject({ status: "unavailable",
      structuralOutcome: "not_better", costEfficiencyClaimAllowed: false });
  });

  it("keeps differing tool-loop gateway-call counts in the cost result while actor topology stays fixed", () => {
    const value: any = comparison();
    value.candidate.calls.push({ ...value.candidate.calls[0], executionId: "candidate-call-2", inputTokens: 10, outputTokens: 2 });
    value.candidate.receipts.push({ ...value.candidate.receipts[0], executionId: "candidate-call-2",
      gatewayRequestId: "gateway-candidate-2", inputTokens: 10, outputTokens: 2, customerCostUsd: 0.01 });
    value.budgetPolicy.maximumCombinedGatewayCalls = 3;
    expect(analyzePiCostComparison(value)).toMatchObject({ structuralOutcome: "candidate_lower_cost",
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
});
