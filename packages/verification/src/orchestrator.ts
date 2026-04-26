import type {
  VerificationResult,
  Verifier,
  VerifierContext,
} from "@nextain/agent-types";

export interface OrchestratorOptions {
  /** Default per-runner timeout. Phase 1 = 60_000 (60s). */
  timeoutMs?: number;
  /** Pass-through env. */
  env?: Record<string, string>;
}

/**
 * VerificationOrchestrator — runs verifiers in parallel with D27 3중 방어:
 *   L1: abort signal (cancel propagation)
 *   L2: per-runner spawn manages SIGTERM/SIGKILL on timeout
 *   L3: wall-clock timeout (default 60s, per-runner)
 *
 * Returns all VerificationResult, never throws on individual runner failure.
 * If signal aborts mid-flight, runners that have not finished emit a
 * partial result with pass: false.
 */
export class VerificationOrchestrator {
  readonly #verifiers: readonly Verifier[];
  readonly #opts: OrchestratorOptions;

  constructor(verifiers: readonly Verifier[], opts: OrchestratorOptions = {}) {
    this.#verifiers = verifiers;
    this.#opts = opts;
  }

  async runAll(
    workdir: string,
    signal: AbortSignal,
  ): Promise<readonly VerificationResult[]> {
    const ctx: VerifierContext = {
      signal,
      timeoutMs: this.#opts.timeoutMs ?? 60_000,
      ...(this.#opts.env !== undefined && { env: this.#opts.env }),
    };
    return Promise.all(
      this.#verifiers.map(async (v) => {
        try {
          return await v.run(workdir, ctx);
        } catch (e) {
          return {
            runner: v.id,
            pass: false,
            stats: { errorsTail: (e as Error).message ?? "unknown error" },
            durationMs: 0,
          } satisfies VerificationResult;
        }
      }),
    );
  }
}
