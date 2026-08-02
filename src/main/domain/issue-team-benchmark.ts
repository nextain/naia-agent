export interface IssueTeamBenchmarkObservation {
  readonly roleOrderMatches: boolean;
  readonly writeBoundaryViolations: number;
  readonly adapterReadOnlyEnforced: boolean;
  readonly repairCycles: number;
  readonly cleanCycles: number;
  readonly duplicateRoleEffects: number;
  readonly unknownInflightRecovery: boolean;
  readonly legacyProfilePreserved: boolean;
  readonly receiptCount: number;
  readonly distinctReceiptIdentities: number;
  readonly allCostsMeasured: boolean;
  readonly expectedCostUsd: number;
  readonly observedCostUsd: number;
}
export function evaluateIssueTeamBenchmark(input: IssueTeamBenchmarkObservation) {
  const gates = {
    ordering: input.roleOrderMatches,
    writeBoundary: input.writeBoundaryViolations === 0,
    adapterBoundary: input.adapterReadOnlyEnforced,
    convergence: input.repairCycles === 1 && input.cleanCycles === 2,
    duplicateDispatch: input.duplicateRoleEffects === 0,
    recovery: input.unknownInflightRecovery,
    legacyPreservation: input.legacyProfilePreserved,
    receiptIsolation: input.receiptCount > 0 && input.distinctReceiptIdentities === input.receiptCount,
    costAccounting: input.allCostsMeasured && Number.isFinite(input.expectedCostUsd) && Number.isFinite(input.observedCostUsd)
      && Math.abs(input.expectedCostUsd - input.observedCostUsd) < 1e-9,
  };
  return { gates, claimAllowed: Object.values(gates).every(Boolean) };
}
