// UC-HLMEM fixture record/replay (FR-HLMEM-6) — CI runs the pure scoring pipeline
// over recorded LIVE observations with NO model and NO key (G15 fixture-only).
import { buildResult } from "./pipeline.js";
import { summarize } from "./metrics.js";
export const HUMANLIKE_FIXTURE_VERSION = 1;
/** Re-score a fixture with the pure pipeline — no model, no key, deterministic. */
export function replayFixture(fixture) {
    const results = fixture.probes.map((p) => buildResult({
        scenarioId: p.scenarioId,
        targetUserId: p.targetUserId,
        condition: p.condition,
        correctLabel: p.correctLabel,
        responseText: p.responseText,
        recallReturnedTarget: p.recallReturnedTarget,
        memoryInjected: p.memoryInjected,
    }));
    return { results, summary: summarize(results) };
}
const CONDITIONS = new Set(["matched", "mismatched", "blind"]);
export function validateFixture(x) {
    if (typeof x !== "object" || x === null)
        return false;
    const f = x;
    if (f.version !== HUMANLIKE_FIXTURE_VERSION)
        return false;
    if (!Array.isArray(f.probes))
        return false;
    return f.probes.every((p) => {
        const r = p;
        return typeof r.scenarioId === "string" &&
            typeof r.targetUserId === "string" &&
            // condition MUST be a known enum — a typo would otherwise pass here and then be
            // silently dropped by statFor (no bucket) → invisible all-zero metrics.
            CONDITIONS.has(r.condition) &&
            (r.correctLabel === "A" || r.correctLabel === "B") &&
            typeof r.responseText === "string" &&
            typeof r.recallReturnedTarget === "boolean" &&
            typeof r.memoryInjected === "boolean";
    });
}
