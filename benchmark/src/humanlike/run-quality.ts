// UC-HLMEM live-run quality controls. These functions are deterministic so CI can
// verify that a recorded benchmark is reproducible and cannot pass on infra errors.
import { createHash } from "node:crypto";
import type { HumanlikeResult, MemoryCondition } from "./types.js";

export const DEFAULT_HUMANLIKE_SEED = "hlmem-v1";

/** Stable A/B placement derived from SHA-256(seed, trial key). */
export function correctOptionIsA(seed: string, trialKey: string): boolean {
  const digest = createHash("sha256").update(seed).update("\0").update(trialKey).digest();
  return (digest[0]! & 1) === 0;
}

export type RunValidityStatus = "complete" | "invalid-infrastructure";

export interface RunValidity {
  readonly status: RunValidityStatus;
  readonly total: number;
  readonly scored: number;
  readonly execErrors: number;
  readonly missingConditions: readonly MemoryCondition[];
}

const REQUIRED_CONDITIONS: readonly MemoryCondition[] = ["matched", "mismatched", "blind"];

/** A live run is publishable only when every planned condition scored and no call failed. */
export function assessRunValidity(results: readonly HumanlikeResult[]): RunValidity {
  const execErrors = results.filter((r) => r.outcome === "exec-error").length;
  const scored = results.length - execErrors;
  const missingConditions = REQUIRED_CONDITIONS.filter(
    (condition) => !results.some((r) => r.trace.condition === condition && r.outcome !== "exec-error"),
  );
  return {
    status: results.length > 0 && execErrors === 0 && missingConditions.length === 0
      ? "complete"
      : "invalid-infrastructure",
    total: results.length,
    scored,
    execErrors,
    missingConditions,
  };
}
