import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const runnerPath = join(root, "benchmark/run-pi-cost-comparison-live.mjs");
const contractPath = join(root, "benchmark/orchestration/pi-cost-comparison.json");
const fixturePath = join(root, "benchmark/fixtures/pi-cost-comparison/base");
const digestRunnerPath = join(root, "benchmark/digest-tree.mjs");

describe("Pi live cost-comparison runner", () => {
  it("pins the exact frozen fixture and task before any paid arm", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const taskDigest = `sha256:${createHash("sha256").update(JSON.stringify(contract.task)).digest("hex")}`;
    expect(contract.schemaVersion).toBe(2);
    expect(contract.taskDigest).toBe(taskDigest);
    expect(contract.baselineDigest).toBe(digestTree(fixturePath));

    const source = readFileSync(runnerPath, "utf8");
    const paidArm = source.indexOf("candidate = await runArm");
    for (const gate of ["!confirmed", "!key", "contract.taskDigest !== actualTaskDigest",
      "contract.baselineDigest !== actualBaseline", "!pinnedPrices", "durable --output path is required"]) {
      expect(source.indexOf(gate), gate).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(gate), gate).toBeLessThan(paidArm);
    }
    expect(source).not.toContain("rmSync(root");
    expect(source).toContain("initializeGatewayRequestBudget");
    expect(source).toContain('"benchmark/digest-tree.mjs"');
    expect(source).toContain("checkpoint reopen process failed");
    expect(source).toContain("status: \"unavailable\"");
    const guardedSetup = source.indexOf("try {", source.indexOf("let billingModule"));
    expect(guardedSetup).toBeGreaterThan(0);
    expect(source.indexOf("await import(pathToFileURL", guardedSetup)).toBeGreaterThan(guardedSetup);
    expect(source.indexOf("initializeGatewayRequestBudget", guardedSetup)).toBeGreaterThan(guardedSetup);
  });

  it("reopens the frozen tree in a separate process and reproduces its digest", () => {
    const run = spawnSync(process.execPath, [digestRunnerPath, fixturePath, "--ignore-git"],
      { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(digestTree(fixturePath));
  });

  it("exits with zero calls when explicit confirmation is absent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-cost-runner-test-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ };
    try {
      const output = join(temporary, "result.json");
      const run = spawnSync(process.execPath, [runnerPath, "--output", output], { cwd: root, env, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ schemaVersion: 2, status: "unavailable",
        paidCalls: 0, gatewayCalls: 0, reason: "explicit paid-comparison confirmation missing",
        costEfficiencyClaimAllowed: false });
      const first = readFileSync(output, "utf8");
      const repeated = spawnSync(process.execPath, [runnerPath, "--output", output], { cwd: root, env, encoding: "utf8" });
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({ reason: "paid comparison output or artifact path already exists" });
      expect(readFileSync(output, "utf8")).toBe(first);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("still exits with zero calls when confirmation exists but price versions are unpinned", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-cost-runner-test-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ,
      NAIA_API_KEY: "test-only-not-used", NAIA_PI_COST_CONFIRM: "1" };
    try {
      const output = join(temporary, "result.json");
      const run = spawnSync(process.execPath,
        [runnerPath, "--confirm-paid-comparison", "--output", output], { cwd: root, env, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ status: "unavailable", paidCalls: 0,
        gatewayCalls: 0, reason: "model price versions are not pinned", costEfficiencyClaimAllowed: false });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});

function digestTree(path: string): string {
  const hash = createHash("sha256");
  for (const file of walk(path)) {
    hash.update(relative(path, file).replaceAll("\\", "/")); hash.update("\0");
    hash.update(readFileSync(file)); hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function walk(path: string): string[] {
  return readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? walk(child) : [child];
  });
}
