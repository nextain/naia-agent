import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Pi continuous-loop deterministic benchmark", () => {
  it("reproduces every zero-paid hard gate", () => {
    const root = mkdtempSync(join(tmpdir(), "naia-pi-bench-test-"));
    try {
      const output = join(root, "result.json"); const repeatedOutput = join(root, "result-repeat.json");
      const run = spawnSync(process.execPath, ["benchmark/run-pi-continuous-loop-deterministic.mjs", "--output", output],
        { cwd: process.cwd(), encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const repeated = spawnSync(process.execPath,
        ["benchmark/run-pi-continuous-loop-deterministic.mjs", "--output", repeatedOutput],
        { cwd: process.cwd(), encoding: "utf8" });
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(readFileSync(repeatedOutput, "utf8")).toBe(readFileSync(output, "utf8"));
      const result = JSON.parse(readFileSync(output, "utf8"));
      expect(result).toMatchObject({ paidCalls: 0, claimAllowed: true,
        costClaim: "deterministic harness only; no live Azure price comparison" });
      expect(Object.values(result.gates).every(Boolean)).toBe(true);
      expect(result.evidence.endToEnd).toMatchObject({ states: ["completed", "failed"],
        duplicateSubmitDeduplicated: true, restartExact: true });
      expect(result.evidence.endToEnd.repairCycles).toBeGreaterThanOrEqual(1);
      expect(result.evidence.endToEnd).toMatchObject({ modelEffects: 20,
        budget: { paidCalls: 20, activeReservations: 0, costBasis: "estimated" } });
      expect(result.evidence.distConformance).toMatchObject({ exact: true, mismatches: [] });
      expect(result.evidence.openCodeRuntimeEdges).toEqual([]);
      expect(result.evidence.openCodeDetectorSelfTest).toMatchObject({ pass: true,
        cases: [{ name: "static-import", expected: 1, actual: 1 },
          { name: "aliased-spawn", expected: 1, actual: 1 },
          { name: "secondary-alias", expected: 1, actual: 1 },
          { name: "default-child-process", expected: 1, actual: 1 },
          { name: "commonjs", expected: 2, actual: 2 },
          { name: "computed-dynamic-import", expected: 1, actual: 1 },
          { name: "renamed-wrapper", expected: 1, actual: 1 },
          { name: "fallback-command", expected: 1, actual: 1 },
          { name: "compatibility-label", expected: 0, actual: 0 }] });
      expect(result.gates).toMatchObject({ receiptConflictBlocked: true, driftBlockedAndReserved: true,
        verificationFailurePreserved: true, compositionBudgetSettled: true,
        executedDistMatchesSource: true, openCodeDetectorSelfTest: true, noOpenCodeEdge: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
