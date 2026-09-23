// ports/surfacing — background small-LLM surfacing (nextain/naia-shell#692). The handler only consumes/schedules.
import type { SurfacingTurn } from "../domain/surfacing.js";

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
  /** Status only: true when a small LLM is configured and surfacing is enabled. */
  active(): boolean;
  /** Stops scheduling, aborts running jobs, waits for them. */
  close(): Promise<void>;
}
