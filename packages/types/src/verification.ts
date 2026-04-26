/**
 * Verifier — runs automatic checks (test/lint/build/type_check) after a
 * sub-agent task to produce honest reports (D19, D27 — 3중 방어).
 *
 * Spec: docs/adapter-contract.md §5
 */
import type { Logger } from "./observability.js";
import type { VerificationStats } from "./stream.js";

export interface VerifierContext {
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number; // default 60s for Phase 1, 5min for Phase 2+
}

export interface VerificationResult {
  readonly runner: string;
  readonly pass: boolean;
  readonly stats: VerificationStats;
  readonly durationMs: number;
  readonly stdoutTail?: string;
  readonly errorTail?: string;
  /** True if result is partial due to timeout (D27 partial-on-timeout). */
  readonly partial?: boolean;
}

export interface Verifier {
  readonly id: "test" | "lint" | "build" | "type_check" | string;
  readonly defaultCommand: string;
  /** Run verifier in workdir. Never throws on test failure (=> pass:false). */
  run(workdir: string, ctx: VerifierContext): Promise<VerificationResult>;
}
