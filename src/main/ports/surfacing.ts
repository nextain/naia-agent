// ports/surfacing — background small-LLM surfacing (nextain/naia-shell#692). The handler only consumes/schedules.
import type { SurfacingMode, SurfacingTurn, ThresholdPolicy } from "../domain/surfacing.js";

export interface SurfacingSnapshot {
  /** Framed block for the system prompt; "" = the small LLM found nothing relevant. */
  readonly block: string;
  /** surfacingKey of every memory candidate the small LLM judged (picked or not). */
  readonly judgedKeys: ReadonlySet<string>;
  readonly surfacedCount: number;
}

export interface SurfacingPort {
  /** Turn start: returns and removes the result prepared after this session's previous turn. Also cancels a job still
   *  running for this session. undefined = nothing ready → caller keeps today's recall injection. Never throws. */
  consume(sessionId: string): SurfacingSnapshot | undefined;
  /** After a completed turn: starts the background job and returns immediately. Never throws, never blocks. */
  schedule(input: { readonly sessionId: string; readonly turns: readonly SurfacingTurn[] }): void;
  /** Surfacing mode: "off" | "on-llm" | "on-threshold" (#693). */
  mode(): SurfacingMode;
  /** Active threshold policy for threshold-gated surfacing (#693). */
  policy(): ThresholdPolicy;
  /** @deprecated Use mode() === "on-llm" instead. */
  active?(): boolean;
  /** Stops scheduling, aborts running jobs, waits for them. */
  close(): Promise<void>;
}
