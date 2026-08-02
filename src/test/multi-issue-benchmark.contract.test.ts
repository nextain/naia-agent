import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateMultiIssueBenchmark, type MultiIssueBenchmarkObservation } from "../main/domain/multi-issue-benchmark.js";

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../benchmark/orchestration/multi-issue-deterministic.json", import.meta.url)), "utf8")) as {
  paidCalls: number;
  observation: MultiIssueBenchmarkObservation;
};

describe("UC-ORCH-002 deterministic benchmark claim gates", () => {
  it("accepts the frozen zero-paid-call observation only when every hard gate passes", () => {
    expect(corpus.paidCalls).toBe(0);
    expect(evaluateMultiIssueBenchmark(corpus.observation)).toEqual({
      gates: { completion: true, isolation: true, fairness: true, concurrency: true, restart: true, visibility: true, costAccounting: true },
      claimAllowed: true,
    });
  });

  it.each([
    ["completion", { terminal: 3 }],
    ["isolation", { identityLeakCount: 1 }],
    ["fairness", { observedStartOrder: ["issue-b", "issue-a", "issue-c", "issue-d"] }],
    ["concurrency", { maximumObservedConcurrency: 3 }],
    ["restart", { restartDuplicateEffects: 1 }],
    ["visibility", { visibilityCountMatches: false }],
    ["costAccounting", { allCostsMeasured: false }],
  ] as const)("rejects a %s counterexample", (gate, patch) => {
    const result = evaluateMultiIssueBenchmark({ ...corpus.observation, ...patch });
    expect(result.gates[gate]).toBe(false);
    expect(result.claimAllowed).toBe(false);
  });
});
