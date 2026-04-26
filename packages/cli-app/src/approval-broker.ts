import * as readline from "node:readline";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
} from "@nextain/agent-types";

/**
 * Phase 2 Day 2.3 — CLI ApprovalBroker (readline y/N prompt).
 *
 * Decisions:
 * - D38 — default-deny T3, 30s timeout auto-deny, "always allow" 차단
 * - Architect P0-2 — DI inject (cli-app, not core)
 * - Paranoid P0-2 — fresh request per tier (no cached approval)
 *
 * UX:
 *   $ pnpm naia-agent "..."
 *   ⚠ approval required (T2): write src/api.ts? [y/N]
 *   > y
 *   ✓ approved
 */
export interface CliApprovalBrokerOptions {
  /** Approval timeout per request (ms). Default 30s. */
  timeoutMs?: number;
  /** stdout writer (for testing). Default process.stdout. */
  out?: NodeJS.WritableStream;
  /** stdin reader (for testing). Default process.stdin. */
  in?: NodeJS.ReadableStream;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CliApprovalBroker implements ApprovalBroker {
  readonly #timeoutMs: number;
  readonly #out: NodeJS.WritableStream;
  readonly #in: NodeJS.ReadableStream;

  constructor(opts: CliApprovalBrokerOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#out = opts.out ?? process.stdout;
    this.#in = opts.in ?? process.stdin;
  }

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const tier = request.tier;
    const tool = request.invocation.name;
    const reason = request.reason ?? `${tool} requires permission`;

    this.#out.write(`  ⚠ approval required (${tier}): ${reason} [y/N]\n> `);

    const rl = readline.createInterface({
      input: this.#in,
      output: this.#out,
      terminal: false,
    });

    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (d: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        resolve(d);
      };

      const timer = setTimeout(() => {
        rl.close();
        this.#out.write(`  ⏱ approval timeout (${this.#timeoutMs / 1000}s) — denied\n`);
        settle({ status: "timeout", at: Date.now() });
      }, this.#timeoutMs);

      rl.once("line", (line: string) => {
        clearTimeout(timer);
        const trimmed = line.trim().toLowerCase();
        // P0-2 (Paranoid) — only "y" or "yes" approves. No "always" / "all".
        if (trimmed === "y" || trimmed === "yes") {
          this.#out.write(`  ✓ approved\n`);
          settle({ status: "approved", at: Date.now() });
        } else {
          this.#out.write(`  ✘ denied\n`);
          settle({
            status: "denied",
            reason: trimmed.length > 0 ? `user input: ${trimmed}` : "user denied",
            at: Date.now(),
          });
        }
        rl.close();
      });

      rl.once("close", () => {
        clearTimeout(timer);
        // If neither line nor timeout fired before close, auto-deny
        settle({ status: "denied", reason: "input closed", at: Date.now() });
      });
    });
  }
}

/**
 * AutoDenyBroker — convenient default for non-interactive contexts (CI, tests).
 * Always denies. Useful as fallback when no readline available.
 */
export class AutoDenyApprovalBroker implements ApprovalBroker {
  async decide(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      status: "denied",
      reason: "AutoDenyApprovalBroker (non-interactive context)",
      at: Date.now(),
    };
  }
}

/**
 * AutoApproveBroker — for testing only. NEVER use in production.
 */
export class AutoApproveApprovalBroker implements ApprovalBroker {
  async decide(_request: ApprovalRequest): Promise<ApprovalDecision> {
    return { status: "approved", at: Date.now() };
  }
}
