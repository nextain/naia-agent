// Benchmark metrics contract — Jaccard drift, strict fact-recall, task-accuracy.
//
// Stage 1a port of the orchestration-independent deterministic metric core from
// the pre-rewrite monorepo (benchmark/src/metrics.ts). These are PURE functions:
// same input → same output. Tests assert specific numeric outputs and include
// stub-detecting cases (a constant-return stub would fail).

import { describe, it, expect } from "vitest";
import {
  taskAccuracy,
  factRecall,
  latencyPercentiles,
  driftScore,
  type ProbeJudgement,
  type LatencySample,
} from "../../benchmark/src/metrics.js";
import type { FixtureProbe } from "../../benchmark/src/fixture.js";

const factRecallProbe = (question = "q"): FixtureProbe => ({
  afterTurn: 0,
  type: "fact-recall",
  question,
  expectedKeywords: ["x"],
});
const taskProbe = (): FixtureProbe => ({
  afterTurn: 0,
  type: "task-accuracy",
  criterion: "c",
});

const j = (probe: FixtureProbe, pass: boolean): ProbeJudgement => ({
  probe,
  response: "r",
  pass,
});

describe("driftScore — token-overlap Jaccard (deterministic)", () => {
  it("identical strings → 1.0 (exact-equal fast path)", () => {
    expect(driftScore("the quick brown fox", "the quick brown fox")).toBe(1.0);
  });

  it("disjoint token sets → 0", () => {
    expect(driftScore("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("known partial overlap → exact Jaccard fraction", () => {
    // A = {a,b,c,d}, B = {a,b,e}. intersection = {a,b} = 2.
    // union = |A|+|B|-inter = 4+3-2 = 5. Jaccard = 2/5 = 0.4.
    expect(driftScore("a b c d", "a b e")).toBeCloseTo(0.4, 12);
  });

  it("case + punctuation are normalized before tokenizing", () => {
    // "Hello, World!" → {hello, world}; "hello world" → {hello, world}.
    // Strings differ (so not the equal fast-path) but token sets are identical → 1.0.
    expect(driftScore("Hello, World!", "hello world")).toBe(1.0);
  });

  it("both empty-after-tokenize → 1.0; one empty → 0", () => {
    expect(driftScore("!!!", "...")).toBe(1.0); // both tokenize to empty set
    expect(driftScore("hello", "!!!")).toBe(0); // {hello} vs {} → 0/1
  });

  it("Unicode letters (Korean) count as tokens (\\p{L})", () => {
    // {네이버, 백엔드} vs {네이버} → inter 1, union 2 → 0.5.
    expect(driftScore("네이버 백엔드", "네이버")).toBeCloseTo(0.5, 12);
  });

  // Stub-detector: a stub returning a constant (e.g. always 1.0 or always 0)
  // cannot satisfy BOTH the 0.4 partial-overlap case AND the disjoint=0 case.
  it("stub-detector: distinct inputs yield distinct, non-constant scores", () => {
    const a = driftScore("a b c d", "a b e"); // 0.4
    const b = driftScore("alpha beta", "gamma delta"); // 0
    const c = driftScore("same tokens", "same tokens"); // 1.0
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("factRecall — strict: every fact-recall probe must pass", () => {
  it("filters to fact-recall probes only, ignores task-accuracy", () => {
    const judgements = [
      j(factRecallProbe(), true),
      j(taskProbe(), false), // ignored by factRecall (wrong type)
      j(factRecallProbe(), true),
    ];
    expect(factRecall(judgements)).toBe(1.0); // 2/2 fact-recall pass
  });

  it("a single failed fact-recall drops the score (strict survival)", () => {
    const judgements = [
      j(factRecallProbe("a"), true),
      j(factRecallProbe("b"), false),
      j(factRecallProbe("c"), true),
      j(factRecallProbe("d"), true),
    ];
    expect(factRecall(judgements)).toBeCloseTo(0.75, 12); // 3/4
  });

  it("no fact-recall probes present → 0 (empty filtered set)", () => {
    expect(factRecall([j(taskProbe(), true)])).toBe(0);
  });
});

describe("taskAccuracy — per-probe pass rate", () => {
  it("empty → 0", () => {
    expect(taskAccuracy([])).toBe(0);
  });
  it("all pass → 1, all fail → 0, mixed → exact fraction", () => {
    expect(taskAccuracy([j(taskProbe(), true), j(taskProbe(), true)])).toBe(1);
    expect(taskAccuracy([j(taskProbe(), false), j(taskProbe(), false)])).toBe(0);
    // 1 of 3 → 1/3.
    expect(
      taskAccuracy([j(taskProbe(), true), j(taskProbe(), false), j(taskProbe(), false)]),
    ).toBeCloseTo(1 / 3, 12);
  });
});

describe("latencyPercentiles — p50/p99 + compaction average", () => {
  const s = (latencyMs: number, compaction = false): LatencySample => ({
    turnIdx: 0,
    latencyMs,
    compaction,
  });

  it("empty → zeros", () => {
    expect(latencyPercentiles([])).toEqual({ p50: 0, p99: 0, compactionAvg: 0 });
  });

  it("p50/p99 use floor-index over the sorted samples", () => {
    // 10 samples 10..100 sorted. p50 idx = floor(10*0.5)=5 → value 60.
    // p99 idx = min(9, floor(10*0.99)=9) → value 100.
    const samples = [30, 10, 100, 50, 20, 70, 40, 90, 60, 80].map((v) => s(v));
    const r = latencyPercentiles(samples);
    expect(r.p50).toBe(60);
    expect(r.p99).toBe(100);
  });

  it("compactionAvg averages only compaction turns; 0 when none", () => {
    const samples = [s(100, true), s(200, true), s(999, false)];
    expect(latencyPercentiles(samples).compactionAvg).toBe(150);
    expect(latencyPercentiles([s(100, false)]).compactionAvg).toBe(0);
  });
});
