import type { HumanlikeResult, MemoryCondition } from "./types.js";
export interface ConditionStat {
    readonly condition: MemoryCondition;
    readonly correct: number;
    readonly wrong: number;
    readonly unparsed: number;
    readonly execError: number;
    /** trials scored (correct+wrong+unparsed); exec-error excluded (infra failure). */
    readonly scored: number;
    /** correct / scored, or **null when scored==0** (condition absent/not-measured) so
     *  a missing baseline is NOT silently treated as accuracy 0 (would inflate deltas). */
    readonly accuracy: number | null;
    /** A-predictions / **parsed** (correct+wrong) — position-bias telltale (~0.5 neutral).
     *  null when no parsed predictions. Denominator excludes unparsed so it reads A/(A+B). */
    readonly pickedARate: number | null;
}
/** Prediction accuracy for one condition = correct / scored (exec-error excluded).
 *  null when the condition was never measured (scored==0). */
export declare function predictionAccuracy(results: readonly HumanlikeResult[], condition: MemoryCondition): number | null;
export interface HumanlikeSummary {
    readonly matched: ConditionStat;
    readonly mismatched: ConditionStat;
    readonly blind: ConditionStat;
    /** memory lift = acc(matched) − acc(blind). null if either condition unmeasured. */
    readonly memoryLift: number | null;
    /** self-specificity = acc(matched) − acc(mismatched). null if either unmeasured. */
    readonly selfSpecificity: number | null;
    /** mismatched below blind (>0 ⇒ wrong-user memory ACTIVELY misleads). null if unmeasured. */
    readonly mismatchedBelowBlind: number | null;
}
export declare function summarize(results: readonly HumanlikeResult[]): HumanlikeSummary;
