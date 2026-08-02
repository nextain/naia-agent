import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateMultiIssueBenchmark, type MultiIssueBenchmarkObservation } from "../main/domain/multi-issue-benchmark.js";

const runnerPath = fileURLToPath(new URL("../../benchmark/run-multi-issue-deterministic.mjs", import.meta.url));
const artifactPath = fileURLToPath(new URL("../../benchmark/results/multi-issue-deterministic.json", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
let cachedObservation: MultiIssueBenchmarkObservation | undefined;

function actualObservation(): MultiIssueBenchmarkObservation {
  if (cachedObservation) return cachedObservation;
  const artifactBytes = readFileSync(artifactPath, "utf8");
  const artifact = JSON.parse(artifactBytes) as { sourceRevision: string };
  const workRoot = join(repositoryRoot, ".agents/work");
  mkdirSync(workRoot, { recursive: true });
  const cleanDist = mkdtempSync(join(workRoot, "multi-issue-benchmark-dist-"));
  try {
    const build = spawnSync(join(repositoryRoot, "node_modules/.bin/tsc"), ["-p", "tsconfig.json", "--outDir", cleanDist], { cwd: repositoryRoot, encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync(process.execPath, [runnerPath, "--source-revision", artifact.sourceRevision, "--dist-dir", cleanDist], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(artifactBytes);
    const result = JSON.parse(run.stdout) as { paidCalls: number; claimAllowed: boolean; observation: MultiIssueBenchmarkObservation };
    expect(result.paidCalls).toBe(0);
    expect(result.claimAllowed).toBe(true);
    cachedObservation = result.observation;
    return cachedObservation;
  } finally {
    rmSync(cleanDist, { recursive: true, force: true });
  }
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
