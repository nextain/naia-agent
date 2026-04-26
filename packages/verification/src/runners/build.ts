import type {
  VerificationResult,
  Verifier,
  VerifierContext,
} from "@nextain/agent-types";
import { runShellVerifier } from "./shell.js";

/** BuildVerifier — runs `pnpm build` (or override). Exit-code only. */
export class BuildVerifier implements Verifier {
  readonly id = "build";
  readonly defaultCommand: string;

  constructor(opts: { command?: string } = {}) {
    this.defaultCommand = opts.command ?? "pnpm build";
  }

  async run(workdir: string, ctx: VerifierContext): Promise<VerificationResult> {
    const [cmd, ...args] = this.defaultCommand.split(/\s+/);
    if (!cmd) {
      return {
        runner: this.id,
        pass: false,
        stats: {},
        durationMs: 0,
      };
    }
    const r = await runShellVerifier(cmd, args, workdir, ctx.signal, {
      ...(ctx.timeoutMs !== undefined && { timeoutMs: ctx.timeoutMs }),
      ...(ctx.env !== undefined && { env: { ...ctx.env } }),
    });
    const pass = !r.timedOut && r.exitCode === 0;
    const result: VerificationResult = {
      runner: this.id,
      pass,
      stats: {},
      durationMs: r.durationMs,
    };
    if (r.errorTail) (result as { errorTail?: string }).errorTail = r.errorTail;
    if (r.stdoutTail) (result as { stdoutTail?: string }).stdoutTail = r.stdoutTail;
    if (r.timedOut) (result as { partial?: boolean }).partial = true;
    return result;
  }
}
