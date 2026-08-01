import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { orderedObligationsEqual } from "../main/domain/orchestration-benchmark.js";

interface RouteRun {
  readonly hardGates: Readonly<Record<string, boolean>>;
  readonly receipts: readonly { readonly role: string; tokenCountsAvailable: boolean; readonly cost: { readonly state: string; readonly usd?: number } }[];
}

const corpusPath = fileURLToPath(new URL("../../benchmark/orchestration/single-issue-cases.json", import.meta.url));
const runnerPath = fileURLToPath(new URL("../../benchmark/run-single-issue-live.mjs", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  schemaVersion: number;
  benchmarkId: string;
  claimPolicy: string;
  routes: Record<string, Record<string, string>>;
  requiredReceiptRoles: string[];
  hardGates: string[];
  cases: { id: string; kind: string }[];
};

function evaluateClaim(candidate: RouteRun, control: RouteRun, requiredRoles: readonly string[], hardGates: readonly string[]) {
  const routePasses = (run: RouteRun) => hardGates.every((gate) => run.hardGates[gate] === true);
  const complete = (run: RouteRun) => requiredRoles.every((role) => {
    const receipts = run.receipts.filter((receipt) => receipt.role === role);
    return receipts.length > 0 && receipts.every((receipt) => receipt.tokenCountsAvailable
      && receipt.cost.state === "measured" && Number.isFinite(receipt.cost.usd));
  });
  if (!routePasses(candidate) || !routePasses(control) || !complete(candidate) || !complete(control)) {
    return { claimAllowed: false, savingsUsd: null };
  }
  const cost = (run: RouteRun) => run.receipts.reduce((sum, receipt) => sum + Number(receipt.cost.usd), 0);
  return { claimAllowed: true, savingsUsd: cost(control) - cost(candidate) };
}

function passingRun(costPerRole: number): RouteRun {
  return {
    hardGates: Object.fromEntries(corpus.hardGates.map((gate) => [gate, true])),
    receipts: corpus.requiredReceiptRoles.map((role) => ({ role, tokenCountsAvailable: true, cost: { state: "measured", usd: costPerRole } })),
  };
}

describe("UC-ORCH-001 frozen composition benchmark", () => {
  it("pins two complete routes and unique cases including one paired live coding case", () => {
    expect(corpus.schemaVersion).toBe(1);
    expect(Object.keys(corpus.routes).sort()).toEqual(["allSol", "lunaProxy"]);
    expect(corpus.routes.lunaProxy).toMatchObject({ naia: "gpt-5.6-luna", naiaReasoning: "low", moderator: "gpt-5.6-sol", moderatorReasoning: "high", workerReasoning: "medium", reporter: "gpt-5.6-luna", reporterReasoning: "low" });
    expect(corpus.routes.allSol).toMatchObject({ naia: "gpt-5.6-sol", naiaReasoning: "low", moderator: "gpt-5.6-sol", moderatorReasoning: "high", workerReasoning: "high", reporter: "gpt-5.6-sol", reporterReasoning: "low" });
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(corpus.cases.length);
    expect(corpus.cases.filter((item) => item.kind === "live-paired")).toHaveLength(1);
    expect(corpus.requiredReceiptRoles).toEqual(["naia", "moderator", "worker", "verifier", "reporter"]);
    expect(corpus.hardGates).toContain("profile_request_exact");
  });

  it("allows a numeric comparison only after both routes pass every hard gate with measured receipts", () => {
    const result = evaluateClaim(passingRun(0.01), passingRun(0.02), corpus.requiredReceiptRoles, corpus.hardGates);
    expect(result).toEqual({ claimAllowed: true, savingsUsd: 0.05 });
  });

  it("forbids savings claims on quality failure or any unavailable actor cost", () => {
    const qualityFailure = passingRun(0.01);
    (qualityFailure.hardGates as Record<string, boolean>).obligations_preserved = false;
    expect(evaluateClaim(qualityFailure, passingRun(0.02), corpus.requiredReceiptRoles, corpus.hardGates)).toEqual({ claimAllowed: false, savingsUsd: null });

    const missingCost = passingRun(0.01);
    const worker = missingCost.receipts.find((receipt) => receipt.role === "worker")!;
    (worker.cost as { state: string; usd?: number }).state = "unavailable";
    delete (worker.cost as { state: string; usd?: number }).usd;
    expect(evaluateClaim(missingCost, passingRun(0.02), corpus.requiredReceiptRoles, corpus.hardGates)).toEqual({ claimAllowed: false, savingsUsd: null });

    const missingTokens = passingRun(0.01);
    missingTokens.receipts.find((receipt) => receipt.role === "worker")!.tokenCountsAvailable = false;
    expect(evaluateClaim(missingTokens, passingRun(0.02), corpus.requiredReceiptRoles, corpus.hardGates)).toEqual({ claimAllowed: false, savingsUsd: null });
  });

  it("uses the runner's exact ordered obligation predicate and rejects contradictory substrings", () => {
    const expected = ["fix add()", "pass the frozen Node test", "change only math.mjs"];
    expect(orderedObligationsEqual([...expected], expected)).toBe(true);
    expect(orderedObligationsEqual(["fix add()", "pass the frozen Node test", "do not change only math.mjs"], expected)).toBe(false);
    expect(orderedObligationsEqual([...expected].reverse(), expected)).toBe(false);
  });

  it("charges a paid receipt even when strict actor-result validation rejects the payload", () => {
    const runner = readFileSync(runnerPath, "utf8");
    expect(runner).toContain("error instanceof IssueActorResultError");
    expect(runner).toContain("chargeMeasuredReceipt(error.receipt, method, paid)");
  });
});
