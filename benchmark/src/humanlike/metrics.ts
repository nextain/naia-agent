// UC-HLMEM metrics (FR-HLMEM-5) — predictionAccuracy + selfSpecificity. Pure.
// Orthogonal to the existing benchmark metrics (taskAccuracy/factRecall/drift/latency).
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

function statFor(results: readonly HumanlikeResult[], condition: MemoryCondition): ConditionStat {
  const rs = results.filter((r) => r.trace.condition === condition);
  let correct = 0, wrong = 0, unparsed = 0, execError = 0, pickedA = 0;
  for (const r of rs) {
    switch (r.outcome) {
      case "correct": correct++; break;
      case "wrong": wrong++; break;
      case "unparsed": unparsed++; break;
      case "exec-error": execError++; break;
    }
    if ((r.outcome === "correct" || r.outcome === "wrong") && r.trace.predicted === "A") pickedA++;
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
export function predictionAccuracy(results: readonly HumanlikeResult[], condition: MemoryCondition): number | null {
  return statFor(results, condition).accuracy;
}

/** null-safe delta: null if either operand is null (a condition was not measured). */
function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

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

export function summarize(results: readonly HumanlikeResult[]): HumanlikeSummary {
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
