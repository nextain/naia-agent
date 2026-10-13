import type { HumanlikeScenario } from "./types.js";
/** Parse the forced `예측: A|B` format. null = unparseable.
 *  Robust to: a word starting with A/B ("Apple" ≠ A — word-boundary guarded) and a
 *  negation ("B가 아니라 A" → A). Takes standalone A/B tokens in the ~40 chars after
 *  the first 예측; a trailing "아니라/말고" negation picks the LAST token. */
export declare function parsePrediction(text: string): "A" | "B" | null;
/** An empty/degenerate response is an execution/infra failure (e.g. empty live
 *  completion from a bad token/credential), NOT a clean prediction — must be
 *  separated so it never false-scores (FR-HLMEM-6). */
export declare function isDegenerateResponse(text: string): boolean;
export interface AssignedOptions {
    readonly optA: string;
    readonly optB: string;
    readonly correctLabel: "A" | "B";
    readonly probe: string;
}
/**
 * Position-bias control (FR-HLMEM-4): assign the target user's correct option and
 * the other option to labels A/B. `correctIsA` is injected (Math.random in the
 * runner; fixed in tests) so this stays a pure function.
 */
export declare function assignOptions(scenario: HumanlikeScenario, targetUserId: string, correctIsA: boolean): AssignedOptions;
