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
  readonly accuracy: number; // correct / scored (0 if scored==0)
  readonly pickedARate: number; // A-predictions / scored — position-bias telltale (~0.5 = neutral)
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
    if (r.outcome !== "exec-error" && r.trace.predicted === "A") pickedA++;
  }
  const scored = correct + wrong + unparsed;
  return {
    condition, correct, wrong, unparsed, execError, scored,
    accuracy: scored === 0 ? 0 : correct / scored,
    pickedARate: scored === 0 ? 0 : pickedA / scored,
  };
}

/** Prediction accuracy for one condition = correct / scored (exec-error excluded). */
export function predictionAccuracy(results: readonly HumanlikeResult[], condition: MemoryCondition): number {
  return statFor(results, condition).accuracy;
}

export interface HumanlikeSummary {
  readonly matched: ConditionStat;
  readonly mismatched: ConditionStat;
  readonly blind: ConditionStat;
  /** memory lift = acc(matched) − acc(blind), in [-1,1]. */
  readonly memoryLift: number;
  /** self-specificity = acc(matched) − acc(mismatched). */
  readonly selfSpecificity: number;
  /** mismatched below blind (>0 ⇒ wrong-user memory ACTIVELY misleads). */
  readonly mismatchedBelowBlind: number;
}

export function summarize(results: readonly HumanlikeResult[]): HumanlikeSummary {
  const matched = statFor(results, "matched");
  const mismatched = statFor(results, "mismatched");
  const blind = statFor(results, "blind");
  return {
    matched, mismatched, blind,
    memoryLift: matched.accuracy - blind.accuracy,
    selfSpecificity: matched.accuracy - mismatched.accuracy,
    mismatchedBelowBlind: blind.accuracy - mismatched.accuracy,
  };
}
