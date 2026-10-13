// UC-HLMEM classifier — trace → outcome. Pure. Redefined against MemoryPort
// AUTOMATIC recall (FR-HLMEM-1): NO model-emitted <recall> marker bucket, NO
// "부적절=실패" moral grading (filter=bias, SoT). Axes = retrieval + prediction.
import { isDegenerateResponse, parsePrediction } from "./parse.js";
/** Deterministic outcome from a trace. exec-error (infra) is separated first so a
 *  degenerate/empty response never counts as a prediction (correct OR wrong). */
export function classifyHumanlikeTrace(trace) {
    if (isDegenerateResponse(trace.responseText))
        return "exec-error";
    if (trace.predicted === null)
        return "unparsed";
    return trace.predicted === trace.correctLabel ? "correct" : "wrong";
}
/** Build a result: parse the response into a trace field + classify. `recallReturnedTarget`
 *  and `memoryInjected` are supplied by the SUT (automatic recall observation). */
export function buildResult(input) {
    const trace = {
        scenarioId: input.scenarioId,
        targetUserId: input.targetUserId,
        condition: input.condition,
        correctLabel: input.correctLabel,
        predicted: parsePrediction(input.responseText),
        recallReturnedTarget: input.recallReturnedTarget,
        memoryInjected: input.memoryInjected,
        responseText: input.responseText,
    };
    return { trace, outcome: classifyHumanlikeTrace(trace) };
}
