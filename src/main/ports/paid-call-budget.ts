import type { ActorReceipt } from "../domain/issue-orchestration.js";

export interface PaidCallBudgetPolicy {
  readonly maxPaidCalls: number;
  readonly maxUsd: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface PaidCallReservation {
  readonly idempotencyKey: string;
  readonly expectedProvider: string;
  readonly expectedModel: string;
  readonly expectedReasoningEffort?: string;
  readonly reservedUsd: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
}
export type PaidCallAllowance = Omit<PaidCallReservation,
  "idempotencyKey" | "expectedProvider" | "expectedModel" | "expectedReasoningEffort">;

export interface PaidCallBudgetSnapshot extends PaidCallBudgetPolicy {
  readonly paidCalls: number;
  readonly activeReservations: number;
  readonly chargedUsd: number;
  readonly chargedInputTokens: number;
  readonly chargedOutputTokens: number;
  readonly costBasis: "none" | "reserved" | "measured" | "estimated" | "mixed";
}
export interface PaidCallReservationStatus {
  readonly idempotencyKey: string;
  readonly status: "active" | "settled";
  readonly expectedProvider: string;
  readonly expectedModel: string;
  readonly reservedUsd: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
}

/** Reserve before a provider effect; settle only from its bound receipt. */
export interface PaidCallBudgetPort {
  reserve(input: PaidCallReservation): void;
  settle(idempotencyKey: string, receipt: ActorReceipt): void;
  snapshot(): PaidCallBudgetSnapshot;
  reservations(): readonly PaidCallReservationStatus[];
  close(): void;
}
