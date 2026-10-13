import type { HumanlikeOutcome, HumanlikeResult, HumanlikeTrace } from "./types.js";
/** Deterministic outcome from a trace. exec-error (infra) is separated first so a
 *  degenerate/empty response never counts as a prediction (correct OR wrong). */
export declare function classifyHumanlikeTrace(trace: HumanlikeTrace): HumanlikeOutcome;
/** Build a result: parse the response into a trace field + classify. `recallReturnedTarget`
 *  and `memoryInjected` are supplied by the SUT (automatic recall observation). */
export declare function buildResult(input: {
    scenarioId: string;
    targetUserId: string;
    condition: HumanlikeTrace["condition"];
    correctLabel: "A" | "B";
    responseText: string;
    recallReturnedTarget: boolean;
    memoryInjected: boolean;
}): HumanlikeResult;
