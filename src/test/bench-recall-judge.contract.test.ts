// Benchmark recall-judge contract — deterministic Korean recall judge + tier gate.
//
// Stage 1a port of benchmark/src/recall-judge.ts (faithful from the pre-rewrite
// monorepo packages/runtime/src/bench/recall-bench-judge.ts). Pure module — no
// model, no I/O, no cloud. Tests cover: determinism (same input twice →
// identical), tier-gate behavior (small capability-only vs mid strict), a real
// Korean knowledge-update fixture scored correctly, abstention, and leak
// detection. Fixtures are loaded from benchmark/fixtures/ and validated.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  koIncludes,
  koNormalizeForJudge,
  WELL_FORMED_MARKER,
  LOOSE_MARKER_LEAK,
  tierForModel,
  evaluateTier,
  TIER_GATES,
  type TrialResult,
} from "../../benchmark/src/recall-judge.js";
import { validateFixture, type Fixture } from "../../benchmark/src/fixture.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../benchmark/fixtures",
);
const loadFixture = (file: string): Fixture =>
  validateFixture(JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")));

const T = (
  markerWellFormed: boolean,
  roundTrip: boolean,
  leaked: boolean,
): TrialResult => ({ markerWellFormed, roundTrip, leaked });

describe("koIncludes (deterministic Korean keyword judge)", () => {
  it("plain noun containment + normalization", () => {
    expect(koIncludes("저는 보리차를 좋아해요", "보리차")).toBe(true);
    expect(koIncludes("커피(변경) 마심", "커피 마심")).toBe(true); // strips (변경)
    expect(koIncludes("녹차만 마십니다", "보리차")).toBe(false);
  });
  it("verb-ending polarity synonym map (안 마셔 → 안 마심)", () => {
    expect(koIncludes("술은 안 마셔", "안 마심")).toBe(true);
  });
  it("koNormalizeForJudge strips (변경), lowercases, trims", () => {
    expect(koNormalizeForJudge("  HELLO(변경) ")).toBe("hello");
  });
});

describe("determinism — same input twice → identical output", () => {
  it("koIncludes is referentially stable", () => {
    const a = koIncludes("술은 안 마셔", "안 마심");
    const b = koIncludes("술은 안 마셔", "안 마심");
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
  it("evaluateTier on the same trials yields byte-identical verdict", () => {
    const trials = [T(true, true, false), T(true, false, true), T(false, true, false)];
    const v1 = evaluateTier(trials, TIER_GATES.mid);
    const v2 = evaluateTier(trials, TIER_GATES.mid);
    expect(JSON.stringify(v1)).toBe(JSON.stringify(v2));
  });
});

describe("marker structure / leak detectors", () => {
  it("WELL_FORMED matches a proper marker, rejects malformed", () => {
    expect(WELL_FORMED_MARKER.test("<recall>내 이름</recall>")).toBe(true);
    expect(WELL_FORMED_MARKER.test("<recal<내 이름</recal>")).toBe(false);
    expect(WELL_FORMED_MARKER.test("그냥 평범한 답변")).toBe(false);
    // {2,256} lower bound: a 1-char marker is inert, must NOT count as capable.
    expect(WELL_FORMED_MARKER.test("<recall>x</recall>")).toBe(false);
    expect(WELL_FORMED_MARKER.test("<recall>xy</recall>")).toBe(true);
  });
  it("LOOSE_MARKER_LEAK catches malformed residue the strict parser misses", () => {
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

describe("evaluateTier — SMALL = capability only (user directive)", () => {
  it("PASSES on ≥1 well-formed marker even with 0 accuracy + 100% leak", () => {
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
  it("small gate ACCEPTS what mid gate REJECTS (strictness rises with size)", () => {
    // 1 marker, 0% accuracy: small passes (capability), mid fails (struct 1<3).
    const trials = [T(true, false, false), T(false, false, false), T(false, false, false)];
    expect(evaluateTier(trials, TIER_GATES.small).pass).toBe(true);
    expect(evaluateTier(trials, TIER_GATES.mid).pass).toBe(false);
  });
});

describe("fixture-driven scoring (real F-KR-* fixtures, deterministic)", () => {
  it("knowledge-update F-KR-KU-01: answer naming 네이버 round-trips; 카카오-only does not", () => {
    const fx = loadFixture("F-KR-KU-01-knowledge-update.fixture.json");
    const probe = fx.probes.find((p) => p.type === "fact-recall");
    expect(probe).toBeDefined();
    if (!probe || probe.type !== "fact-recall") throw new Error("expected fact-recall probe");
    const keyword = probe.expectedKeywords[0]!; // "네이버"
    expect(keyword).toBe("네이버");

    // Correct (latest fact) answer → round-trip TRUE.
    const correct = "현재 직장은 네이버입니다. 이전에는 카카오에 계셨고요.";
    expect(probe.expectedKeywords.every((k) => koIncludes(correct, k))).toBe(true);

    // Stale-only (old fact) answer → round-trip FALSE (네이버 keyword absent).
    const stale = "지금 다니시는 곳은 카카오입니다.";
    expect(koIncludes(stale, keyword)).toBe(false);

    // Determinism: scoring the same answer twice is identical.
    expect(koIncludes(correct, keyword)).toBe(koIncludes(correct, keyword));
  });

  it("information-extraction F-KR-IE-01: ALL allergy keywords must survive (strict recall)", () => {
    const fx = loadFixture("F-KR-IE-01-information-extraction.fixture.json");
    const probe = fx.probes.find((p) => p.type === "fact-recall");
    if (!probe || probe.type !== "fact-recall") throw new Error("expected fact-recall probe");
    expect([...probe.expectedKeywords].sort()).toEqual(
      ["견과류", "캐슈넛", "새우", "호두"].sort(),
    );

    // Complete answer → every keyword present.
    const complete = "알레르기: 견과류(특히 호두, 캐슈넛)와 새우입니다.";
    expect(probe.expectedKeywords.every((k) => koIncludes(complete, k))).toBe(true);

    // Partial answer dropping 새우 → strict recall fails (not every keyword survives).
    const partial = "알레르기: 견과류(호두, 캐슈넛)입니다.";
    expect(probe.expectedKeywords.every((k) => koIncludes(partial, k))).toBe(false);
  });

  it("abstention F-KR-AB-01: no fact-recall keyword probe (abstention is task-accuracy only)", () => {
    const fx = loadFixture("F-KR-AB-01-abstention.fixture.json");
    // The abstention fixture has only a task-accuracy probe — there is no ground
    // fact to recall (the user never gave a birthday). The deterministic judge
    // correctly has nothing to keyword-match here.
    expect(fx.probes.some((p) => p.type === "task-accuracy")).toBe(true);
    expect(fx.probes.some((p) => p.type === "fact-recall")).toBe(false);
  });

  it("leak detection: a malformed marker leaking into the final answer is caught", () => {
    // Simulate a trial: well-formed marker absent, fact recalled, but residue leaked.
    const finalAnswer = "당신이 좋아하는 건 <recal<보리차</recal> 입니다.";
    const leaked = LOOSE_MARKER_LEAK.test(finalAnswer);
    const wellFormed = WELL_FORMED_MARKER.test(finalAnswer);
    const roundTrip = koIncludes(finalAnswer, "보리차");
    expect(leaked).toBe(true);
    expect(wellFormed).toBe(false);
    expect(roundTrip).toBe(true);
    const trial: TrialResult = { markerWellFormed: wellFormed, roundTrip, leaked };
    // Under MID gate this single leaky trial pushes leakRate to 100% > 20% → fail.
    const v = evaluateTier([trial], TIER_GATES.mid);
    expect(v.leakRate).toBe(1);
    expect(v.pass).toBe(false);
  });
});

describe("all bundled fixtures validate against the ported schema", () => {
  it("F001-F010 + F-KR-* parse + validateFixture without throwing", () => {
    const files = [
      "F001-customer-support.fixture.json",
      "F002-coding-pair.fixture.json",
      "F003-research-synthesis.fixture.json",
      "F004-persona-roleplay.fixture.json",
      "F005-tool-heavy.fixture.json",
      "F006-mixed-language.fixture.json",
      "F007-calculation-chain.fixture.json",
      "F008-story-continuation.fixture.json",
      "F009-preference-tracking.fixture.json",
      "F010-websearch-heavy.fixture.json",
      "F-KR-AB-01-abstention.fixture.json",
      "F-KR-IE-01-information-extraction.fixture.json",
      "F-KR-KU-01-knowledge-update.fixture.json",
      "F-KR-MS-01-multi-session.fixture.json",
      "F-KR-TR-01-temporal-reasoning.fixture.json",
    ];
    const ids = files.map((f) => loadFixture(f).id);
    expect(ids.length).toBe(15);
    expect(new Set(ids).size).toBe(15); // all ids unique
  });
});
