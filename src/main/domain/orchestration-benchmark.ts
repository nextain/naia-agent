import type { ActorReceipt } from "./issue-orchestration.js";

export function orderedObligationsEqual(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function identitiesIndependent(receipts: readonly ActorReceipt[]): boolean {
  return new Set(receipts.map((item) => item.sessionId)).size === receipts.length
    && new Set(receipts.map((item) => item.executionId)).size === receipts.length;
}

export function measuredRoles(receipts: readonly ActorReceipt[], requiredRoles: readonly string[]): boolean {
  return requiredRoles.every((role) => {
    const matches = receipts.filter((item) => item.role === role);
    return matches.length > 0 && matches.every((item) => item.cost.state === "measured" && Number.isFinite(item.cost.usd));
  });
}
