import { spawn } from "node:child_process";
import type { VerificationStats } from "@nextain/agent-types";

export interface ShellRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  errorTail: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Spawn `command` with `args` in workdir. Captures up to `tailKb` of
 * stdout/stderr (last N bytes). Honors AbortSignal and wall-clock
 * timeoutMs (D27 layer 3 — wall-clock timeout, when caller wraps).
 */
export async function runShellVerifier(
  command: string,
  args: readonly string[],
  workdir: string,
  signal: AbortSignal,
  opts: { timeoutMs?: number; tailBytes?: number; env?: Record<string, string> } = {},
): Promise<ShellRunResult> {
  const tailBytes = opts.tailBytes ?? 8 * 1024;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();

  const child = spawn(command, [...args], {
    cwd: workdir,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutTail = "";
  let errorTail = "";

  const append = (which: "out" | "err", chunk: Buffer) => {
    const s = chunk.toString("utf8");
    if (which === "out") {
      stdoutTail = (stdoutTail + s).slice(-tailBytes);
    } else {
      errorTail = (errorTail + s).slice(-tailBytes);
    }
  };

  child.stdout?.on("data", (c: Buffer) => append("out", c));
  child.stderr?.on("data", (c: Buffer) => append("err", c));

  let timedOut = false;
  const wallClockTimer = setTimeout(() => {
    timedOut = true;
    if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 500);
  }, timeoutMs);

  const onAbort = () => {
    if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 500);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return new Promise<ShellRunResult>((resolve) => {
    child.on("close", (code, sig) => {
      clearTimeout(wallClockTimer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        signal: sig,
        stdoutTail,
        errorTail,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("error", () => {
      clearTimeout(wallClockTimer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: -1,
        signal: null,
        stdoutTail,
        errorTail,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

/**
 * Parse vitest "Tests  X passed (Y) | Z failed (Y)" footer lines.
 * Returns 0/0/0 if format unrecognized.
 */
export function parseVitestStats(output: string): VerificationStats {
  // accept "Tests  4 passed (4)" or "Tests  3 passed | 1 failed (4)"
  const passed = matchInt(output, /Tests\s+(\d+)\s+passed/);
  const failed = matchInt(output, /(\d+)\s+failed/);
  const skipped = matchInt(output, /(\d+)\s+skipped/);
  const total = matchInt(output, /\((\d+)\)/);
  const stats: VerificationStats = {};
  if (passed !== null) stats.passed = passed;
  if (failed !== null) stats.failed = failed;
  if (skipped !== null) stats.skipped = skipped;
  if (total !== null) stats.total = total;
  if (failed !== null && failed > 0) {
    // include errors tail (last 1KB of stderr/output for context)
    stats.errorsTail = output.slice(-1024);
  }
  return stats;
}

function matchInt(input: string, re: RegExp): number | null {
  const m = re.exec(input);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
