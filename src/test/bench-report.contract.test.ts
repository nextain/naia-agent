// Benchmark report contract — Stage 1b.
//
// formatReport on known FixtureResult[] → asserts specific markdown content:
// the aggregate pass count, per-fixture table rows (PASS/FAIL + scores), and a
// Failures section that surfaces failing-probe notes. Non-vacuous: the exact
// strings are checked, and a stub returning a constant string would fail the
// distinct-content assertions.
//
// Imports from ../../benchmark/src/... (outside tsc rootDir → excluded from
// `pnpm build`, run only under vitest, same as the other bench tests).

import { describe, it, expect } from "vitest";
import { formatReport } from "../../benchmark/src/report.js";
import type { FixtureResult } from "../../benchmark/src/runner.js";

const passing: FixtureResult = {
  fixtureId: "F-PASS",
  scores: { factRecall: 1.0, taskAccuracy: 1.0, driftScore: 1.0 },
  pass: true,
  details: [{ probeIndex: 0, type: "fact-recall", pass: true, note: "all 2 keyword(s) present" }],
  errors: [],
};

const failing: FixtureResult = {
  fixtureId: "F-FAIL",
  scores: { factRecall: 0.0, taskAccuracy: 0.5, driftScore: 0.25 },
  pass: false,
  details: [
    { probeIndex: 0, type: "fact-recall", pass: false, note: "missing keyword(s): 새우" },
    { probeIndex: 1, type: "task-accuracy", pass: false, note: "SUT judged fail" },
  ],
  errors: ["probe 2 (drift): no response from SUT"],
};

describe("formatReport — aggregate header", () => {
  it("reports the correct pass/fail counts", () => {
    const md = formatReport([passing, failing]);
    expect(md).toContain("# Benchmark Report");
    expect(md).toContain("- **Fixtures**: 2");
    expect(md).toContain("- **Passed**: 1/2");
    expect(md).toContain("- **Failed**: 1/2");
  });

  it("all-pass set reports full pass count and no Failures section", () => {
    const md = formatReport([passing]);
    expect(md).toContain("- **Passed**: 1/1");
    expect(md).not.toContain("## Failures");
  });

  it("empty results → 0/0 (no crash, non-vacuous header)", () => {
    const md = formatReport([]);
    expect(md).toContain("- **Fixtures**: 0");
    expect(md).toContain("- **Passed**: 0/0");
  });
});

describe("formatReport — per-fixture table", () => {
  it("renders one row per fixture with PASS/FAIL and the three score axes", () => {
    const md = formatReport([passing, failing]);
    expect(md).toContain("| Fixture | Result | Fact-recall | Task-accuracy | Drift | Errors |");
    // Passing row: PASS, scores 1.000, no errors (—).
    expect(md).toContain("| `F-PASS` | PASS | 1.000 | 1.000 | 1.000 | — |");
    // Failing row: FAIL, exact formatted scores, 1 error.
    expect(md).toContain("| `F-FAIL` | FAIL | 0.000 | 0.500 | 0.250 | 1 |");
  });
});

describe("formatReport — Failures section", () => {
  it("lists failing-probe notes and errors only for failing fixtures", () => {
    const md = formatReport([passing, failing]);
    expect(md).toContain("## Failures");
    expect(md).toContain("### `F-FAIL`");
    expect(md).toContain("- probe 0 (fact-recall): missing keyword(s): 새우");
    expect(md).toContain("- probe 1 (task-accuracy): SUT judged fail");
    expect(md).toContain("- error: probe 2 (drift): no response from SUT");
    // Passing fixture must NOT appear in the Failures section.
    expect(md).not.toContain("### `F-PASS`");
  });
});

// Stub-detector: a constant-string formatter cannot vary its pass count and
// per-fixture rows with the input.
describe("stub-detector: report content tracks the results", () => {
  it("distinct result sets produce distinct reports", () => {
    const a = formatReport([passing]);
    const b = formatReport([failing]);
    expect(a).not.toBe(b);
    expect(a).toContain("- **Passed**: 1/1");
    expect(b).toContain("- **Passed**: 0/1");
  });
});
