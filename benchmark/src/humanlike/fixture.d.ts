import { type HumanlikeSummary } from "./metrics.js";
import type { HumanlikeResult, MemoryCondition } from "./types.js";
export declare const HUMANLIKE_FIXTURE_VERSION: 1;
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
export declare function replayFixture(fixture: HumanlikeFixture): {
    results: HumanlikeResult[];
    summary: HumanlikeSummary;
};
export declare function validateFixture(x: unknown): x is HumanlikeFixture;
