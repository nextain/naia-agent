export interface MultiIssueBenchmarkObservation {
  readonly submitted: number;
  readonly terminal: number;
  readonly identityLeakCount: number;
  readonly expectedStartOrder: readonly string[];
  readonly observedStartOrder: readonly string[];
  readonly configuredConcurrency: number;
  readonly maximumObservedConcurrency: number;
  readonly restartDuplicateEffects: number;
  readonly visibilityCountMatches: boolean;
  readonly allCostsMeasured: boolean;
  readonly expectedCostUsd: number;
  readonly observedCostUsd: number;
}

export interface MultiIssueBenchmarkEvaluation {
  readonly gates: {
    readonly completion: boolean;
    readonly isolation: boolean;
    readonly fairness: boolean;
    readonly concurrency: boolean;
    readonly restart: boolean;
    readonly visibility: boolean;
    readonly costAccounting: boolean;
  };
  readonly claimAllowed: boolean;
}

export function evaluateMultiIssueBenchmark(input: MultiIssueBenchmarkObservation): MultiIssueBenchmarkEvaluation {
  const gates = {
    completion: input.submitted > 0 && input.terminal === input.submitted,
    isolation: input.identityLeakCount === 0,
    fairness: sameStrings(input.expectedStartOrder, input.observedStartOrder),
    concurrency: input.configuredConcurrency > 0 && input.maximumObservedConcurrency <= input.configuredConcurrency,
    restart: input.restartDuplicateEffects === 0,
    visibility: input.visibilityCountMatches,
    costAccounting: input.allCostsMeasured && Number.isFinite(input.expectedCostUsd)
      && Number.isFinite(input.observedCostUsd) && Math.abs(input.expectedCostUsd - input.observedCostUsd) < 1e-9,
  };
  return { gates, claimAllowed: Object.values(gates).every(Boolean) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
