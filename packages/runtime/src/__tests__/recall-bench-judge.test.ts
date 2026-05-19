// Conversational recall bench — deterministic judge + tiered gate (#41 v2).
// Encodes the 2026-05-20 user directive: SMALL tier (e2b) = structure
// capability ONLY (low rate fine, accuracy/leak report-only); strictness
// rises with model size (MID/e4b gates accuracy + leak). No model here.

import { describe, it, expect } from "vitest";
import {
  koIncludes,
  WELL_FORMED_MARKER,
  LOOSE_MARKER_LEAK,
  tierForModel,
  evaluateTier,
  TIER_GATES,
  type TrialResult,
} from "../bench/recall-bench-judge.js";

describe("koIncludes (naia-memory judge parity)", () => {
  it("plain noun containment + normalization", () => {
    expect(koIncludes("저는 보리차를 좋아해요", "보리차")).toBe(true);
    expect(koIncludes("커피(변경) 마심", "커피 마심")).toBe(true); // strips (변경)
    expect(koIncludes("녹차만 마십니다", "보리차")).toBe(false);
  });
  it("verb-ending polarity synonym map", () => {
    expect(koIncludes("술은 안 마셔", "안 마심")).toBe(true);
  });
});

describe("marker structure / leak detectors", () => {
  it("WELL_FORMED matches a proper marker, rejects malformed", () => {
    expect(WELL_FORMED_MARKER.test("<recall>내 이름</recall>")).toBe(true);
    expect(WELL_FORMED_MARKER.test("<recal<내 이름</recal>")).toBe(false);
    expect(WELL_FORMED_MARKER.test("그냥 평범한 답변")).toBe(false);
  });
  it("LOOSE_MARKER_LEAK catches malformed residue the strict parser misses", () => {
    // The exact Step-3 (2026-05-19) e2b failure string.
    expect(LOOSE_MARKER_LEAK.test("<recal<보리차</recal>")).toBe(true);
    expect(LOOSE_MARKER_LEAK.test("</recall>")).toBe(true);
    expect(LOOSE_MARKER_LEAK.test("당신은 보리차를 좋아합니다.")).toBe(false);
  });
});

describe("tierForModel", () => {
  it("e2b→small, e4b→mid, unknown→small (conservative)", () => {
    expect(tierForModel("gemma3n:e2b").id).toBe("small");
    expect(tierForModel("gemma3n:e4b").id).toBe("mid");
    expect(tierForModel("mystery:latest").id).toBe("small");
  });
});

const T = (
  markerWellFormed: boolean,
  roundTrip: boolean,
  leaked: boolean,
): TrialResult => ({ markerWellFormed, roundTrip, leaked });

describe("evaluateTier — SMALL = capability only (user directive)", () => {
  it("PASSES on ≥1 well-formed marker even with 0 accuracy + 100% leak", () => {
    // The crux: a tiny model that emits ONE structurally-valid marker but
    // otherwise garbles the round-trip still PASSES the small gate.
    const trials = [T(true, false, true), T(false, false, true), T(false, false, true)];
    const v = evaluateTier(trials, TIER_GATES.small);
    expect(v.pass).toBe(true);
    expect(v.structureCount).toBe(1);
    expect(v.accuracyRate).toBe(0);
    expect(v.leakRate).toBe(1);
    expect(v.reasons.some((r) => r.includes("report-only"))).toBe(true);
  });
  it("FAILS only if the structure NEVER occurs (0 well-formed markers)", () => {
    const trials = [T(false, true, false), T(false, true, false)];
    const v = evaluateTier(trials, TIER_GATES.small);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain("FAIL");
  });
});

describe("evaluateTier — MID = stricter (accuracy + leak gated)", () => {
  it("FAILS when accuracy below minimum despite enough structure", () => {
    const trials = [
      T(true, false, false),
      T(true, false, false),
      T(true, false, false),
      T(true, true, false),
    ];
    const v = evaluateTier(trials, TIER_GATES.mid); // accuracy 25% < 40%
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes("accuracy") && r.includes("FAIL"))).toBe(true);
  });
  it("FAILS when leak above max even with good accuracy", () => {
    const trials = [
      T(true, true, true),
      T(true, true, true),
      T(true, true, false),
      T(true, true, false),
    ];
    const v = evaluateTier(trials, TIER_GATES.mid); // leak 50% > 20%
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes("leak") && r.includes("FAIL"))).toBe(true);
  });
  it("PASSES when structure + accuracy + leak all within MID gate", () => {
    const trials = [
      T(true, true, false),
      T(true, true, false),
      T(true, true, false),
      T(true, false, false),
    ];
    const v = evaluateTier(trials, TIER_GATES.mid); // struct 4≥3, acc 75%≥40, leak 0≤20
    expect(v.pass).toBe(true);
  });
});
