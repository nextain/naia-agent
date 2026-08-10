import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateIssueTeamBenchmark, type IssueTeamBenchmarkObservation } from "../main/domain/issue-team-benchmark.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const runnerPath = fileURLToPath(new URL("../../benchmark/run-issue-team-deterministic.mjs", import.meta.url));
const artifactPath = fileURLToPath(new URL("../../benchmark/results/issue-team-deterministic.json", import.meta.url));
let cached: IssueTeamBenchmarkObservation | undefined;
function observation(): IssueTeamBenchmarkObservation {
  if (cached) return cached;
  const artifactBytes = readFileSync(artifactPath, "utf8"); const artifact = JSON.parse(artifactBytes) as { sourceRevision: string };
  const work = join(repositoryRoot, ".agents/work"); mkdirSync(work, { recursive: true }); const dist = mkdtempSync(join(work, "issue-team-benchmark-dist-"));
  try {
    const build = spawnSync(process.execPath, [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", dist], { cwd: repositoryRoot, encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync(process.execPath, [runnerPath, "--source-revision", artifact.sourceRevision, "--dist-dir", dist], { cwd: repositoryRoot, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0); expect(JSON.parse(run.stdout)).toEqual(JSON.parse(artifactBytes));
    const output = JSON.parse(run.stdout) as { paidCalls: number; claimAllowed: boolean; observation: IssueTeamBenchmarkObservation };
    expect(output).toMatchObject({ paidCalls: 0, claimAllowed: true }); cached = output.observation; return cached;
  } finally { rmSync(dist, { recursive: true, force: true }); }
}
describe("REQ-023 deterministic issue-team benchmark", () => {
  it("replays the real SQLite state machine with no paid call", () => {
    expect(observation()).toMatchObject({ roleOrderMatches: true, writeBoundaryViolations: 0, adapterReadOnlyEnforced: true,
      roleExecutorBoundaryPreserved: true, parentProjectionValidated: true, repairCycles: 1, cleanCycles: 2,
      productionRouterWired: true,
      duplicateRoleEffects: 0, unknownInflightRecovery: true, legacyProfilePreserved: true, receiptCount: 8, distinctReceiptIdentities: 8 });
    expect(observation().rejectedFailureRecovered).toBe(true);
  });
  it.each([
    ["ordering", { roleOrderMatches: false }], ["writeBoundary", { writeBoundaryViolations: 1 }],
    ["adapterBoundary", { adapterReadOnlyEnforced: false }],
    ["compositionBoundary", { roleExecutorBoundaryPreserved: false }], ["parentBoundary", { parentProjectionValidated: false }],
    ["productionRouting", { productionRouterWired: false }],
    ["convergence", { cleanCycles: 1 }], ["duplicateDispatch", { duplicateRoleEffects: 1 }],
    ["recovery", { unknownInflightRecovery: false }], ["recovery", { rejectedFailureRecovered: false }], ["receiptIsolation", { distinctReceiptIdentities: 7 }],
    ["legacyPreservation", { legacyProfilePreserved: false }],
    ["costAccounting", { observedCostUsd: 0.007 }],
  ] as const)("rejects a %s counterexample", (gate, patch) => {
    const evaluated = evaluateIssueTeamBenchmark({ ...observation(), ...patch }); expect(evaluated.gates[gate]).toBe(false); expect(evaluated.claimAllowed).toBe(false);
  });
});
