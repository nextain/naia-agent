// Benchmark runner contract — Stage 1b.
//
// Drives a fixture through a FAKE deterministic SystemUnderTest and asserts the
// runner scores fact-recall / task-accuracy / drift correctly and renders the
// right pass/fail decision — reusing the Stage-1a metrics (no re-implemented
// scoring). Covers: a passing run, a failing run (a dropped keyword fails strict
// fact-recall), determinism (same input twice → byte-identical result), drift
// scoring against a baseline, axis-gating (an axis a fixture doesn't exercise
// must not sink the verdict), and a stub-detector (a constant-return SUT cannot
// satisfy both the good and bad expectations).
//
// The SUT is INJECTED — the runner imports nothing system-specific. This file
// imports from ../../benchmark/src/... (outside tsc rootDir, so it is excluded
// from `pnpm build` and run only under vitest, same as the other bench tests).

import { describe, it, expect } from "vitest";
import {
  runFixture,
  runFixtures,
  DEFAULT_THRESHOLDS,
  type SystemUnderTest,
  type FixtureInput,
  type ProbeResponse,
} from "../../benchmark/src/runner.js";
import type { Fixture } from "../../benchmark/src/fixture.js";

// ── Fixtures (hand-built, minimal) ──────────────────────────────────────────

const recallFixture: Fixture = {
  id: "T-RECALL",
  domain: "test-recall",
  turns: [
    { role: "user", content: "내 알레르기는 호두랑 새우야" },
    { role: "assistant", content: "호두, 새우 알레르기 기록했습니다" },
  ],
  probes: [
    {
      afterTurn: 2,
      type: "fact-recall",
      question: "알레르기를 나열하시오",
      expectedKeywords: ["호두", "새우"],
    },
  ],
};

const taskFixture: Fixture = {
  id: "T-TASK",
  domain: "test-task",
  turns: [{ role: "user", content: "정리해줘" }],
  probes: [{ afterTurn: 1, type: "task-accuracy", criterion: "정확히 정리했는가" }],
};

const driftFixture: Fixture = {
  id: "T-DRIFT",
  domain: "test-drift",
  turns: [{ role: "user", content: "이야기 계속" }],
  probes: [{ afterTurn: 1, type: "drift", question: "다음 장면" }],
};

// ── Fake deterministic SUTs ─────────────────────────────────────────────────

/** Good run: answers fact-recall with every expected keyword, tasks pass,
 *  drift answer identical to baseline. Pure: no clock, no randomness. */
const goodSut: SystemUnderTest = {
  async run(input: FixtureInput): Promise<readonly ProbeResponse[]> {
    return input.probes.map((p, i) => {
      if (p.type === "fact-recall") {
        return { probeIndex: i, answer: p.expectedKeywords.join(" ") + " 입니다" };
      }
      if (p.type === "task-accuracy") {
        return { probeIndex: i, answer: "정리 완료", taskPass: true };
      }
      return { probeIndex: i, answer: "동일한 장면", baselineAnswer: "동일한 장면" };
    });
  },
};

/** Bad run: drops the LAST expected keyword (strict fact-recall fails), tasks
 *  fail, drift answer disjoint from baseline (drift → 0). Deterministic. */
const badSut: SystemUnderTest = {
  async run(input: FixtureInput): Promise<readonly ProbeResponse[]> {
    return input.probes.map((p, i) => {
      if (p.type === "fact-recall") {
        const kept = p.expectedKeywords.slice(0, -1); // drop one keyword
        return { probeIndex: i, answer: kept.join(" ") + " 입니다" };
      }
      if (p.type === "task-accuracy") {
        return { probeIndex: i, answer: "잘못 정리", taskPass: false };
      }
      return { probeIndex: i, answer: "완전히 다른 토큰들", baselineAnswer: "original baseline words" };
    });
  },
};

describe("runFixture — passing run (good deterministic SUT)", () => {
  it("scores fact-recall 1.0 and passes when every keyword survives", async () => {
    const r = await runFixture(recallFixture, goodSut);
    expect(r.fixtureId).toBe("T-RECALL");
    expect(r.scores.factRecall).toBe(1.0);
    expect(r.pass).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.details).toHaveLength(1);
    expect(r.details[0]!.pass).toBe(true);
    expect(r.details[0]!.type).toBe("fact-recall");
  });

  it("task-accuracy probe passes when SUT reports taskPass=true", async () => {
    const r = await runFixture(taskFixture, goodSut);
    expect(r.scores.taskAccuracy).toBe(1.0);
    expect(r.pass).toBe(true);
  });

  it("drift probe with identical baseline → 1.0 and passes", async () => {
    const r = await runFixture(driftFixture, goodSut);
    expect(r.scores.driftScore).toBe(1.0);
    expect(r.pass).toBe(true);
  });
});

describe("runFixture — failing run (bad deterministic SUT)", () => {
  it("a dropped keyword fails strict fact-recall → fixture fails", async () => {
    const r = await runFixture(recallFixture, badSut);
    // One fact-recall probe, keyword 새우 dropped → 0/1.
    expect(r.scores.factRecall).toBe(0);
    expect(r.pass).toBe(false);
    expect(r.details[0]!.pass).toBe(false);
    expect(r.details[0]!.note).toContain("새우");
  });

  it("task-accuracy fails when SUT reports taskPass=false", async () => {
    const r = await runFixture(taskFixture, badSut);
    expect(r.scores.taskAccuracy).toBe(0);
    expect(r.pass).toBe(false);
  });

  it("disjoint drift answer vs baseline → drift 0 → fails driftMin", async () => {
    const r = await runFixture(driftFixture, badSut);
    expect(r.scores.driftScore).toBe(0);
    expect(r.pass).toBe(false);
  });
});

describe("runFixture — determinism", () => {
  it("same fixture + same SUT twice → byte-identical result", async () => {
    const a = await runFixture(recallFixture, goodSut);
    const b = await runFixture(recallFixture, goodSut);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("bad run is also deterministic", async () => {
    const a = await runFixture(driftFixture, badSut);
    const b = await runFixture(driftFixture, badSut);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("runFixture — axis gating + missing-response handling", () => {
  it("a fixture without a fact-recall probe is not failed by the fact axis", async () => {
    // taskFixture has only a task-accuracy probe; factRecall aggregates to 0
    // but must NOT gate (no fact-recall probe present).
    const r = await runFixture(taskFixture, goodSut);
    expect(r.scores.factRecall).toBe(0); // no fact probes → 0 by definition
    expect(r.pass).toBe(true); // but the fact axis does not gate
  });

  it("a missing probe response fails closed with a recorded error", async () => {
    const emptySut: SystemUnderTest = { async run() { return []; } };
    const r = await runFixture(recallFixture, emptySut);
    expect(r.pass).toBe(false);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("no response");
    expect(r.scores.factRecall).toBe(0);
  });
});

describe("runFixtures — batch", () => {
  it("preserves order and isolates failures across fixtures", async () => {
    const results = await runFixtures([recallFixture, taskFixture, driftFixture], goodSut);
    expect(results.map((r) => r.fixtureId)).toEqual(["T-RECALL", "T-TASK", "T-DRIFT"]);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

describe("thresholds", () => {
  it("DEFAULT_THRESHOLDS are strict (perfect recall/task, drift ≥ 0.5)", () => {
    expect(DEFAULT_THRESHOLDS.factRecallMin).toBe(1.0);
    expect(DEFAULT_THRESHOLDS.taskAccuracyMin).toBe(1.0);
    expect(DEFAULT_THRESHOLDS.driftMin).toBe(0.5);
  });

  it("relaxing factRecallMin lets a partial-recall run pass", async () => {
    // bad run drops 1 of 2 keywords → factRecall 0; with min 0 it passes the axis.
    const r = await runFixture(recallFixture, badSut, {
      factRecallMin: 0,
      taskAccuracyMin: 1,
      driftMin: 0.5,
    });
    expect(r.scores.factRecall).toBe(0);
    expect(r.pass).toBe(true);
  });
});

// Stub-detector: the runner is NOT a constant — a passing good-SUT run and a
// failing bad-SUT run on the SAME fixture must produce DISTINCT verdicts and
// distinct scores. A runner that ignored the SUT (returned a fixed result)
// could not satisfy both rows below.
describe("stub-detector: runner output tracks the injected SUT", () => {
  it("good vs bad SUT on the same fixture yield opposite pass + distinct scores", async () => {
    const good = await runFixture(recallFixture, goodSut);
    const bad = await runFixture(recallFixture, badSut);
    expect(good.pass).toBe(true);
    expect(bad.pass).toBe(false);
    expect(good.scores.factRecall).not.toBe(bad.scores.factRecall);
  });

  it("drift score is non-constant across identical vs disjoint baselines", async () => {
    const identical = await runFixture(driftFixture, goodSut); // 1.0
    const disjoint = await runFixture(driftFixture, badSut); // 0
    expect(new Set([identical.scores.driftScore, disjoint.scores.driftScore]).size).toBe(2);
  });
});
