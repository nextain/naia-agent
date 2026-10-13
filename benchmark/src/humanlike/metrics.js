function statFor(results, condition) {
    const rs = results.filter((r) => r.trace.condition === condition);
    let correct = 0, wrong = 0, unparsed = 0, execError = 0, pickedA = 0;
    for (const r of rs) {
        switch (r.outcome) {
            case "correct":
                correct++;
                break;
            case "wrong":
                wrong++;
                break;
            case "unparsed":
                unparsed++;
                break;
            case "exec-error":
                execError++;
                break;
        }
        if ((r.outcome === "correct" || r.outcome === "wrong") && r.trace.predicted === "A")
            pickedA++;
    }
    const scored = correct + wrong + unparsed;
    const parsed = correct + wrong;
    return {
        condition, correct, wrong, unparsed, execError, scored,
        accuracy: scored === 0 ? null : correct / scored,
        pickedARate: parsed === 0 ? null : pickedA / parsed,
    };
}
/** Prediction accuracy for one condition = correct / scored (exec-error excluded).
 *  null when the condition was never measured (scored==0). */
export function predictionAccuracy(results, condition) {
    return statFor(results, condition).accuracy;
}
/** null-safe delta: null if either operand is null (a condition was not measured). */
function delta(a, b) {
    return a === null || b === null ? null : a - b;
}
export function summarize(results) {
    const matched = statFor(results, "matched");
    const mismatched = statFor(results, "mismatched");
    const blind = statFor(results, "blind");
    return {
        matched, mismatched, blind,
        memoryLift: delta(matched.accuracy, blind.accuracy),
        selfSpecificity: delta(matched.accuracy, mismatched.accuracy),
        mismatchedBelowBlind: delta(blind.accuracy, mismatched.accuracy),
    };
}
