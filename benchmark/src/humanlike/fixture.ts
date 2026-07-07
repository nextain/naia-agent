// UC-HLMEM fixture record/replay (FR-HLMEM-6) — CI runs the pure scoring pipeline
// over recorded LIVE observations with NO model and NO key (G15 fixture-only).
import { buildResult } from "./pipeline.js";
import { summarize, type HumanlikeSummary } from "./metrics.js";
import type { HumanlikeResult, MemoryCondition } from "./types.js";

export const HUMANLIKE_FIXTURE_VERSION = 1 as const;

/** One recorded probe observation (what the live run produced, deterministic to score). */
export interface RecordedProbe {
  readonly scenarioId: string;
  readonly targetUserId: string;
  readonly condition: MemoryCondition;
  readonly correctLabel: "A" | "B";
  readonly responseText: string;
  readonly recallReturnedTarget: boolean;
  readonly memoryInjected: boolean;
}

export interface HumanlikeFixture {
  readonly version: typeof HUMANLIKE_FIXTURE_VERSION;
  readonly recordedAt: string;
  readonly model: string;
  readonly probes: readonly RecordedProbe[];
}

/** Re-score a fixture with the pure pipeline — no model, no key, deterministic. */
export function replayFixture(fixture: HumanlikeFixture): { results: HumanlikeResult[]; summary: HumanlikeSummary } {
  const results = fixture.probes.map((p) =>
    buildResult({
      scenarioId: p.scenarioId,
      targetUserId: p.targetUserId,
      condition: p.condition,
      correctLabel: p.correctLabel,
      responseText: p.responseText,
      recallReturnedTarget: p.recallReturnedTarget,
      memoryInjected: p.memoryInjected,
    }),
  );
  return { results, summary: summarize(results) };
}

export function validateFixture(x: unknown): x is HumanlikeFixture {
  if (typeof x !== "object" || x === null) return false;
  const f = x as Record<string, unknown>;
  if (f.version !== HUMANLIKE_FIXTURE_VERSION) return false;
  if (!Array.isArray(f.probes)) return false;
  return f.probes.every((p) => {
    const r = p as Record<string, unknown>;
    return typeof r.scenarioId === "string" && typeof r.condition === "string" &&
      (r.correctLabel === "A" || r.correctLabel === "B") && typeof r.responseText === "string";
  });
}
