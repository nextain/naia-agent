import type {
  VerificationResult,
  Verifier,
  VerifierContext,
} from "@nextain/agent-types";
import { parseVitestStats, runShellVerifier } from "./shell.js";

/** TestVerifier — runs `pnpm test` (or override) and parses vitest output. */
export class TestVerifier implements Verifier {
  readonly id = "test";
  readonly defaultCommand: string;

  constructor(opts: { command?: string } = {}) {
    this.defaultCommand = opts.command ?? "pnpm test";
  }

  async run(workdir: string, ctx: VerifierContext): Promise<VerificationResult> {
    const [cmd, ...args] = this.defaultCommand.split(/\s+/);
    if (!cmd) {
      return {
        runner: this.id,
        pass: false,
        stats: { errorsTail: "TestVerifier: empty command" },
        durationMs: 0,
      };
    }
    const r = await runShellVerifier(cmd, args, workdir, ctx.signal, {
      ...(ctx.timeoutMs !== undefined && { timeoutMs: ctx.timeoutMs }),
      ...(ctx.env !== undefined && { env: { ...ctx.env } }),
    });
    const combined = r.stdoutTail + r.errorTail;
    const stats = parseVitestStats(combined);
    const pass = !r.timedOut && r.exitCode === 0 && (stats.failed ?? 0) === 0;
    const result: VerificationResult = {
      runner: this.id,
      pass,
      stats,
      durationMs: r.durationMs,
    };
    if (r.stdoutTail) (result as { stdoutTail?: string }).stdoutTail = r.stdoutTail;
    if (r.errorTail) (result as { errorTail?: string }).errorTail = r.errorTail;
    if (r.timedOut) (result as { partial?: boolean }).partial = true;
    return result;
  }
}
