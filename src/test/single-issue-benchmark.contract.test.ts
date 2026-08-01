import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { orderedObligationsEqual } from "../main/domain/orchestration-benchmark.js";
import { makeBudgetedActorPort, ObservedSpendBudget } from "../main/app/observed-spend-budget.js";
import { IssueActorResultError } from "../main/ports/issue-orchestration.js";
import type { ActorReceipt } from "../main/domain/issue-orchestration.js";

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
    expect(corpus.routes.lunaProxy).toMatchObject({ naia: "gpt-5.6-luna", naiaReasoning: "low", moderator: "gpt-5.6-sol", moderatorReasoning: "high", worker: "gpt-5.6-terra", workerReasoning: "medium", reporter: "gpt-5.6-luna", reporterReasoning: "low" });
    expect(corpus.routes.allSol).toMatchObject({ naia: "gpt-5.6-sol", naiaReasoning: "low", moderator: "gpt-5.6-sol", moderatorReasoning: "high", worker: "gpt-5.6-sol", workerReasoning: "high", reporter: "gpt-5.6-sol", reporterReasoning: "low" });
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

  it("behaviorally charges and deduplicates a paid receipt when actor-result validation rejects the payload", async () => {
    const paidReceipt: ActorReceipt = {
      role: "moderator", provider: "fixture", model: "fixture-model", sessionId: "session-1", executionId: "execution-1",
      idempotencyKey: "issue:moderator:0", tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 0,
      outputTokens: 2, latencyMs: 1, cost: { state: "measured", usd: 0.1, source: "fixture" },
    };
    const budget = new ObservedSpendBudget(1, 0.2, 2);
    const actor = makeBudgetedActorPort({ async plan(): Promise<never> {
      throw new IssueActorResultError("invalid actor JSON", paidReceipt);
    } }, "plan", budget);
    await expect(actor.plan()).rejects.toBeInstanceOf(IssueActorResultError);
    await expect(actor.plan()).rejects.toBeInstanceOf(IssueActorResultError);
    expect(budget.paidCalls).toBe(2);
    expect(budget.observedSpendUsd).toBe(0.1);
  });

  it("returns a receipt-carrying rejection after a completed call exceeds its reservation", async () => {
    const paidReceipt: ActorReceipt = {
      role: "worker", provider: "fixture", model: "fixture-model", sessionId: "session-2", executionId: "execution-2",
      idempotencyKey: "issue:dispatch:1", tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 0,
      outputTokens: 2, latencyMs: 1, cost: { state: "measured", usd: 0.25, source: "fixture" },
    };
    const budget = new ObservedSpendBudget(1, 0.2, 1);
    const actor = makeBudgetedActorPort({ async execute() { return { receipt: paidReceipt }; } }, "execute", budget);
    const error = await actor.execute().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueActorResultError);
    expect((error as IssueActorResultError).receipt).toBe(paidReceipt);
    expect(budget.observedSpendUsd).toBe(0.25);
  });

  it("rejects a runtime worker-model override before any paid benchmark call", () => {
    const run = spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NAIA_ORCH_LIVE: "1",
        NAIA_ORCH_MAX_USD: "1",
        NAIA_ORCH_RESERVED_CALL_USD: "0.1",
        NAIA_ORCH_WORKER_MODEL: "gpt-5.6-luna",
      },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("worker bindings are frozen in the corpus");
  });
});
