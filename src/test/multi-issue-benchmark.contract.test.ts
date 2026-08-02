import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateMultiIssueBenchmark, type MultiIssueBenchmarkObservation } from "../main/domain/multi-issue-benchmark.js";

const runnerPath = fileURLToPath(new URL("../../benchmark/run-multi-issue-deterministic.mjs", import.meta.url));

function actualObservation(): MultiIssueBenchmarkObservation {
  const run = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  const result = JSON.parse(run.stdout) as { paidCalls: number; claimAllowed: boolean; observation: MultiIssueBenchmarkObservation };
  expect(result.paidCalls).toBe(0);
  expect(result.claimAllowed).toBe(true);
  return result.observation;
}

describe("UC-ORCH-002 deterministic benchmark claim gates", () => {
  it("runs the real manager/SQLite workload and derives every passing observation", () => {
    const observation = actualObservation();
    expect(observation).toMatchObject({ submitted: 4, terminal: 4, maximumObservedConcurrency: 2, restartDuplicateEffects: 0 });
    expect(evaluateMultiIssueBenchmark(observation).claimAllowed).toBe(true);
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
    const observation = actualObservation();
    const result = evaluateMultiIssueBenchmark({ ...observation, ...patch });
    expect(result.gates[gate]).toBe(false);
    expect(result.claimAllowed).toBe(false);
  });
});
