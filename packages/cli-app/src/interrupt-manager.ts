/**
 * Phase 2 Day 2.1 — InterruptManager
 *
 * Centralizes SIGINT/keypress → AbortController.abort() + downstream propagation.
 * Applied by bin/naia-agent (Phase 1's inline SIGINT handler is replaced).
 *
 * D21 (interrupt) + Architect P0-2 (cli-app位置, not core).
 * Paranoid P2-1 (Phase 1 audit) — debounce double-tap (no double abort message).
 */
export interface InterruptManagerOptions {
  /** Output stream for status messages. Default process.stderr. */
  err?: NodeJS.WritableStream;
  /** Show this message on first SIGINT. Default Korean alert. */
  message?: string;
}

export class InterruptManager {
  readonly #ac = new AbortController();
  readonly #err: NodeJS.WritableStream;
  readonly #message: string;
  #aborted = false;
  #unhook: (() => void) | undefined;

  constructor(opts: InterruptManagerOptions = {}) {
    this.#err = opts.err ?? process.stderr;
    this.#message = opts.message ?? "[알파] interrupt — cancelling";
  }

  get signal(): AbortSignal {
    return this.#ac.signal;
  }

  /** Install SIGINT handler. Returns this. */
  install(): this {
    if (this.#unhook) return this;
    const handler = () => this.trigger("user-SIGINT");
    process.on("SIGINT", handler);
    this.#unhook = () => process.removeListener("SIGINT", handler);
    return this;
  }

  /** Manually trigger interrupt (e.g., from keypress, voice). */
  trigger(reason: string): void {
    if (this.#aborted) return; // P2-1 debounce
    this.#aborted = true;
    this.#err.write(`\n${this.#message}\n`);
    this.#ac.abort(reason);
  }

  /** Remove process listener — call on cleanup. */
  uninstall(): void {
    if (this.#unhook) {
      this.#unhook();
      this.#unhook = undefined;
    }
  }

  get aborted(): boolean {
    return this.#aborted;
  }
}
