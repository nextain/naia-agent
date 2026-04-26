import { describe, expect, it } from "vitest";
import type { Verifier, VerifierContext } from "@nextain/agent-types";
import { TestVerifier } from "../runners/test.js";
import { TypeCheckVerifier } from "../runners/typecheck.js";
import { LintVerifier } from "../runners/lint.js";
import { BuildVerifier } from "../runners/build.js";
import { VerificationOrchestrator } from "../orchestrator.js";
import { formatReport, reportStatsFromInput } from "../reporter.js";
import { parseVitestStats, runShellVerifier } from "../runners/shell.js";

const ctx = (): VerifierContext => ({ signal: new AbortController().signal });

describe("runShellVerifier — exit code + tail capture", () => {
  it("captures stdout tail of /usr/bin/echo", async () => {
    const r = await runShellVerifier("/usr/bin/echo", ["hi"], "/tmp", ctx().signal);
    expect(r.exitCode).toBe(0);
    expect(r.stdoutTail).toContain("hi");
  });

  it("non-zero exit code reports as failure", async () => {
    const r = await runShellVerifier("/bin/false", [], "/tmp", ctx().signal);
    expect(r.exitCode).not.toBe(0);
  });

  it("D27 layer 3 — wall-clock timeout kills runaway process", async () => {
    const r = await runShellVerifier("/usr/bin/env", ["sleep", "5"], "/tmp", ctx().signal, {
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
  }, 5000);

  it("D27 layer 1 — abort signal stops in-flight runner", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await runShellVerifier("/usr/bin/env", ["sleep", "5"], "/tmp", ac.signal, {
      timeoutMs: 60_000,
    });
    expect(r.exitCode === null || r.signal !== null).toBe(true);
  }, 5000);
});

describe("parseVitestStats", () => {
  it("parses simple PASS footer", () => {
    const s = parseVitestStats("Tests  24 passed (24)");
    expect(s.passed).toBe(24);
    expect(s.total).toBe(24);
    expect(s.failed ?? 0).toBe(0);
  });

  it("parses mixed PASS/FAIL footer", () => {
    const s = parseVitestStats("Tests  3 passed | 1 failed (4)");
    expect(s.passed).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.total).toBe(4);
  });

  it("returns empty stats for unrecognized output", () => {
    const s = parseVitestStats("nothing matches");
    expect(s.passed).toBeUndefined();
    expect(s.failed).toBeUndefined();
  });
});

describe("Verifiers — TestVerifier / TypeCheckVerifier / LintVerifier / BuildVerifier", () => {
  it("TestVerifier reports exit 0 → pass:true (parseVitestStats unit-tested separately)", async () => {
    const v = new TestVerifier({ command: "/bin/true" });
    const r = await v.run("/tmp", ctx());
    expect(r.runner).toBe("test");
    expect(r.pass).toBe(true);
  });

  it("TestVerifier reports exit non-zero → pass:false", async () => {
    const v = new TestVerifier({ command: "/bin/false" });
    const r = await v.run("/tmp", ctx());
    expect(r.runner).toBe("test");
    expect(r.pass).toBe(false);
  });

  it("TypeCheckVerifier passes on exit 0", async () => {
    const v = new TypeCheckVerifier({ command: "/bin/true" });
    const r = await v.run("/tmp", ctx());
    expect(r.runner).toBe("type_check");
    expect(r.pass).toBe(true);
  });

  it("TypeCheckVerifier fails on non-zero exit", async () => {
    const v = new TypeCheckVerifier({ command: "/bin/false" });
    const r = await v.run("/tmp", ctx());
    expect(r.pass).toBe(false);
  });

  it("LintVerifier passes on exit 0", async () => {
    const v = new LintVerifier({ command: "/bin/true" });
    const r = await v.run("/tmp", ctx());
    expect(r.pass).toBe(true);
  });

  it("BuildVerifier passes on exit 0", async () => {
    const v = new BuildVerifier({ command: "/bin/true" });
    const r = await v.run("/tmp", ctx());
    expect(r.pass).toBe(true);
  });
});

describe("VerificationOrchestrator — parallel + 3중 방어", () => {
  it("runs verifiers in parallel and returns all results", async () => {
    const verifiers: Verifier[] = [
      new TestVerifier({ command: "/usr/bin/printf 'Tests  2 passed (2)\\n'" }),
      new TypeCheckVerifier({ command: "/bin/true" }),
    ];
    const orchestrator = new VerificationOrchestrator(verifiers);
    const results = await orchestrator.runAll("/tmp", new AbortController().signal);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("never throws on individual runner failure (returns FAIL)", async () => {
    const verifiers: Verifier[] = [
      new TypeCheckVerifier({ command: "/bin/false" }),
      new LintVerifier({ command: "/bin/true" }),
    ];
    const orchestrator = new VerificationOrchestrator(verifiers);
    const results = await orchestrator.runAll("/tmp", new AbortController().signal);
    expect(results.length).toBe(2);
    expect(results[0]?.pass).toBe(false);
    expect(results[1]?.pass).toBe(true);
  });

  it("D27 wall-clock timeout — partial result (pass:false, partial:true)", async () => {
    const slow = new TestVerifier({ command: "/usr/bin/env sleep 10" });
    const orchestrator = new VerificationOrchestrator([slow], { timeoutMs: 200 });
    const results = await orchestrator.runAll("/tmp", new AbortController().signal);
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.partial).toBe(true);
  }, 5000);
});

describe("formatReport / reportStatsFromInput", () => {
  it("formats numeric report with files + tests + elapsed", () => {
    const text = formatReport({
      filesChanged: 3,
      additions: 12,
      deletions: 3,
      durationMs: 12_400,
      verifications: [
        {
          runner: "test",
          pass: true,
          stats: { passed: 24, total: 24, failed: 0 },
          durationMs: 3_200,
        },
        { runner: "type_check", pass: true, stats: {}, durationMs: 1_800 },
      ],
    });
    expect(text).toContain("files: 3 (+12/-3)");
    expect(text).toContain("tests: 24/24 PASS");
    expect(text).toContain("type_check: PASS");
    expect(text).toContain("elapsed: 12.4s");
  });

  it("formats failure with failed count", () => {
    const text = formatReport({
      filesChanged: 1,
      additions: 5,
      deletions: 0,
      durationMs: 1_000,
      verifications: [
        {
          runner: "test",
          pass: false,
          stats: { passed: 18, total: 24, failed: 6 },
          durationMs: 500,
        },
      ],
    });
    expect(text).toContain("tests: 18/24 FAIL (failed=6)");
  });

  it("reportStatsFromInput extracts ReportStats", () => {
    const stats = reportStatsFromInput({
      filesChanged: 2,
      additions: 10,
      deletions: 1,
      durationMs: 5_000,
      verifications: [
        {
          runner: "test",
          pass: true,
          stats: { passed: 5, total: 5, failed: 0 },
          durationMs: 1_000,
        },
      ],
    });
    expect(stats.filesChanged).toBe(2);
    expect(stats.testsPassed).toBe(5);
    expect(stats.testsFailed).toBe(0);
  });

  it("partial result shows [partial] tag", () => {
    const text = formatReport({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      durationMs: 200,
      verifications: [
        { runner: "type_check", pass: false, stats: {}, durationMs: 200, partial: true },
      ],
    });
    expect(text).toContain("type_check: FAIL");
    expect(text).toContain("[partial]");
  });
});
