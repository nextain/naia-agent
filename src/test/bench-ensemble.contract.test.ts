// Benchmark ensemble contract — infra-error-excluded majority vote (pure).
//
// Stage 1a port: the OLD `runEnsemble` both invoked judges over a transport AND
// aggregated. Stage 1a keeps ONLY the pure aggregation (`aggregateEnsemble`) —
// it takes ALREADY-COLLECTED per-judge results and returns the consensus. These
// tests inject results directly (no judge is called). The vote / exclusion /
// unreliable arithmetic must match the old implementation exactly.

import { describe, it, expect } from "vitest";
import { aggregateEnsemble } from "../../benchmark/src/judges/ensemble.js";
import {
  isInfraError,
  type JudgeResult,
} from "../../benchmark/src/judges/types.js";

const verdict = (pass: boolean, reason = "r"): JudgeResult => ({
  pass,
  reason,
  latencyMs: 1,
});
const infra = (msg = "cli missing"): JudgeResult => ({
  infraError: msg,
  latencyMs: 0,
});

describe("aggregateEnsemble — infra-error exclusion", () => {
  it("2 valid + 1 infra-error → vote is over the 2 valid only", () => {
    const v = aggregateEnsemble({
      glm: verdict(true),
      codex: verdict(true),
      gemini: infra("key missing"),
    });
    expect(v.validCount).toBe(2); // infra excluded from the tally
    expect(v.infraErrorCount).toBe(1);
    expect(v.unreliable).toBe(false);
    expect(v.pass).toBe(true); // 2 pass > 0 fail
    // perJudge still records the infra result (surfaced separately).
    expect(isInfraError(v.perJudge.gemini!)).toBe(true);
    // reason only mentions the valid judges, not the infra one.
    expect(v.reason).not.toContain("gemini");
    expect(v.reason).toContain("glm: PASS");
  });

  it("all judges infra-error → unreliable=true, pass=false, inconclusive reason", () => {
    const v = aggregateEnsemble({
      glm: infra("network down"),
      codex: infra("timeout"),
      gemini: infra("parse fail"),
    });
    expect(v.validCount).toBe(0);
    expect(v.infraErrorCount).toBe(3);
    expect(v.unreliable).toBe(true);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("unreliable: all 3 judges hit infra errors");
  });
});

describe("aggregateEnsemble — majority vote correctness", () => {
  it("2 pass vs 1 fail → pass=true", () => {
    const v = aggregateEnsemble({
      a: verdict(true),
      b: verdict(true),
      c: verdict(false),
    });
    expect(v.validCount).toBe(3);
    expect(v.pass).toBe(true);
  });

  it("1 pass vs 2 fail → pass=false (majority fails)", () => {
    const v = aggregateEnsemble({
      a: verdict(true),
      b: verdict(false),
      c: verdict(false),
    });
    expect(v.validCount).toBe(3);
    expect(v.pass).toBe(false);
  });

  it("infra exclusion can FLIP the outcome vs naive counting", () => {
    // Naive (count infra as fail): 2 pass vs 2 → no majority → fail.
    // Correct (exclude infra): 2 pass vs 0 fail → pass=true.
    const v = aggregateEnsemble({
      a: verdict(true),
      b: verdict(true),
      c: infra(),
      d: infra(),
    });
    expect(v.validCount).toBe(2);
    expect(v.infraErrorCount).toBe(2);
    expect(v.pass).toBe(true); // would be false if infra counted as fail
  });
});

describe("aggregateEnsemble — tie handling (strict majority)", () => {
  it("1 pass vs 1 fail (tie among valid) → pass=false; reliable (validCount>0)", () => {
    const v = aggregateEnsemble({ a: verdict(true), b: verdict(false) });
    expect(v.validCount).toBe(2);
    expect(v.unreliable).toBe(false); // a tie is NOT unreliable, just not a majority
    expect(v.pass).toBe(false); // majority requires pass > fail (strict)
  });
});

describe("aggregateEnsemble — single judge edge", () => {
  it("one valid PASS → pass=true; one valid FAIL → pass=false", () => {
    expect(aggregateEnsemble({ only: verdict(true) }).pass).toBe(true);
    expect(aggregateEnsemble({ only: verdict(false) }).pass).toBe(false);
  });

  // Stub-detector: a stub returning a constant verdict (always pass / always
  // fail / always unreliable) cannot satisfy all of these simultaneously.
  it("stub-detector: distinct inputs produce distinct verdicts", () => {
    const allPass = aggregateEnsemble({ a: verdict(true), b: verdict(true) });
    const allFail = aggregateEnsemble({ a: verdict(false), b: verdict(false) });
    const allInfra = aggregateEnsemble({ a: infra(), b: infra() });
    expect(allPass.pass).toBe(true);
    expect(allPass.unreliable).toBe(false);
    expect(allFail.pass).toBe(false);
    expect(allFail.unreliable).toBe(false);
    expect(allInfra.pass).toBe(false);
    expect(allInfra.unreliable).toBe(true);
  });
});
