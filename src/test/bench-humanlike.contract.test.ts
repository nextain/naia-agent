// UC-HLMEM deterministic core contract (FR-HLMEM-1·4·5·6). PURE functions:
// same input → same output. Trace is defined against MemoryPort AUTOMATIC recall
// (no model-emitted <recall> marker) and exec-error is separated from prediction.
import { describe, it, expect } from "vitest";
import {
  parsePrediction, isDegenerateResponse, assignOptions,
  classifyHumanlikeTrace, buildResult,
  predictionAccuracy, summarize,
  PREFERENCE_SCENARIOS, SELF_SPEC_SCENARIOS, HUMANLIKE_SCENARIOS,
  replayFixture, validateFixture,
  type HumanlikeResult, type HumanlikeTrace, type HumanlikeFixture,
} from "../../benchmark/src/humanlike/index.js";

const trace = (o: Partial<HumanlikeTrace> & { correctLabel: "A" | "B"; predicted: "A" | "B" | null; responseText: string }): HumanlikeTrace => ({
  scenarioId: "s", targetUserId: "u", condition: "matched",
  recallReturnedTarget: true, memoryInjected: true, ...o,
});

describe("parsePrediction", () => {
  it("parses the forced 예측: A|B first line in several shapes", () => {
    expect(parsePrediction("예측: A\n이유")).toBe("A");
    expect(parsePrediction("예측:B")).toBe("B");
    expect(parsePrediction("예측 : (A) 왜냐하면")).toBe("A");
    expect(parsePrediction("예측： b")).toBe("B");
  });
  it("returns null when no marker", () => {
    expect(parsePrediction("음 글쎄 잘 모르겠어")).toBeNull();
    expect(parsePrediction("")).toBeNull();
  });
});

describe("isDegenerateResponse (exec-error guard)", () => {
  it("flags empty / too-short / letterless as degenerate", () => {
    expect(isDegenerateResponse("")).toBe(true);
    expect(isDegenerateResponse(" ")).toBe(true);
    expect(isDegenerateResponse("😉")).toBe(true);
    expect(isDegenerateResponse("...")).toBe(true);
  });
  it("passes a real response", () => {
    expect(isDegenerateResponse("예측: A")).toBe(false);
  });
});

describe("assignOptions (position-bias control)", () => {
  const sc = SELF_SPEC_SCENARIOS[0]!; // F2-diet, users A/B
  it("correctIsA=true → target's correct option is A, label A", () => {
    const r = assignOptions(sc, "A", true);
    expect(r.correctLabel).toBe("A");
    expect(r.optA).toBe(sc.options.find((o) => o.correctFor === "A")!.text);
    expect(r.probe).toContain("(A)"); expect(r.probe).toContain("(B)");
  });
  it("correctIsA=false → correct option is B, label B", () => {
    const r = assignOptions(sc, "A", false);
    expect(r.correctLabel).toBe("B");
    expect(r.optB).toBe(sc.options.find((o) => o.correctFor === "A")!.text);
  });
  it("throws when target has no option pair", () => {
    expect(() => assignOptions(sc, "does-not-exist", true)).toThrow();
  });
});

describe("classifyHumanlikeTrace", () => {
  it("exec-error takes precedence over prediction (degenerate never scores)", () => {
    expect(classifyHumanlikeTrace(trace({ correctLabel: "A", predicted: null, responseText: "😉" }))).toBe("exec-error");
  });
  it("unparsed / correct / wrong", () => {
    expect(classifyHumanlikeTrace(trace({ correctLabel: "A", predicted: null, responseText: "몰라 그냥 아무거나" }))).toBe("unparsed");
    expect(classifyHumanlikeTrace(trace({ correctLabel: "A", predicted: "A", responseText: "예측: A" }))).toBe("correct");
    expect(classifyHumanlikeTrace(trace({ correctLabel: "A", predicted: "B", responseText: "예측: B" }))).toBe("wrong");
  });
});

describe("buildResult end-to-end", () => {
  it("parses response then classifies", () => {
    const r = buildResult({ scenarioId: "s", targetUserId: "u", condition: "blind", correctLabel: "B", responseText: "예측: B\n왜냐", recallReturnedTarget: false, memoryInjected: false });
    expect(r.trace.predicted).toBe("B");
    expect(r.outcome).toBe("correct");
  });
});

const res = (condition: HumanlikeResult["trace"]["condition"], correctLabel: "A" | "B", responseText: string): HumanlikeResult =>
  buildResult({ scenarioId: "s", targetUserId: "u", condition, correctLabel, responseText, recallReturnedTarget: true, memoryInjected: condition !== "blind" });

describe("metrics", () => {
  it("predictionAccuracy excludes exec-error from the denominator", () => {
    const rs = [res("matched", "A", "예측: A"), res("matched", "A", "예측: B"), res("matched", "A", "😉")];
    // 1 correct, 1 wrong, 1 exec-error → scored=2 → 0.5 (NOT 1/3)
    expect(predictionAccuracy(rs, "matched")).toBe(0.5);
  });
  it("summarize: memoryLift, selfSpecificity, mismatchedBelowBlind", () => {
    const rs = [
      res("matched", "A", "예측: A"), res("matched", "A", "예측: A"), // matched 2/2 = 1.0
      res("mismatched", "A", "예측: B"), res("mismatched", "A", "예측: B"), // mismatched 0/2 = 0.0
      res("blind", "A", "예측: A"), res("blind", "A", "예측: B"), // blind 1/2 = 0.5
    ];
    const s = summarize(rs);
    expect(s.matched.accuracy).toBe(1); expect(s.mismatched.accuracy).toBe(0); expect(s.blind.accuracy).toBe(0.5);
    expect(s.memoryLift).toBeCloseTo(0.5);
    expect(s.selfSpecificity).toBeCloseTo(1.0);
    expect(s.mismatchedBelowBlind).toBeCloseTo(0.5); // wrong-user memory actively misleads
  });
});

describe("scenarios well-formedness", () => {
  it("F1 = 1 user, F2 = 2 opposite users; options correctFor distinct + present", () => {
    for (const sc of PREFERENCE_SCENARIOS) expect(sc.users).toHaveLength(1);
    for (const sc of SELF_SPEC_SCENARIOS) {
      expect(sc.users).toHaveLength(2);
      const ids = new Set(sc.users.map((u) => u.id));
      expect(sc.options[0]!.correctFor).not.toBe(sc.options[1]!.correctFor);
      for (const o of sc.options) if (o.correctFor !== "_") expect(ids.has(o.correctFor)).toBe(true);
    }
  });
  it("held-out: each option text does NOT appear verbatim in any seed (forces generalization)", () => {
    for (const sc of HUMANLIKE_SCENARIOS) {
      const seedText = sc.users.flatMap((u) => u.seed.map((t) => t.userText)).join(" ");
      for (const o of sc.options) expect(seedText.includes(o.text)).toBe(false);
    }
  });
  it("every seed turn has non-empty content (regression: old lineage had a dropped content)", () => {
    for (const sc of HUMANLIKE_SCENARIOS)
      for (const u of sc.users)
        for (const t of u.seed) expect(t.userText.trim().length).toBeGreaterThan(0);
  });
});

describe("fixture replay (CI, no model)", () => {
  it("re-scores recorded observations deterministically", () => {
    const fixture: HumanlikeFixture = {
      version: 1, recordedAt: "2026-07-07T00:00:00Z", model: "test",
      probes: [
        { scenarioId: "s", targetUserId: "A", condition: "matched", correctLabel: "A", responseText: "예측: A", recallReturnedTarget: true, memoryInjected: true },
        { scenarioId: "s", targetUserId: "A", condition: "mismatched", correctLabel: "A", responseText: "예측: B", recallReturnedTarget: true, memoryInjected: true },
      ],
    };
    expect(validateFixture(fixture)).toBe(true);
    const { summary } = replayFixture(fixture);
    expect(summary.matched.accuracy).toBe(1);
    expect(summary.mismatched.accuracy).toBe(0);
    expect(summary.selfSpecificity).toBe(1);
  });
});
