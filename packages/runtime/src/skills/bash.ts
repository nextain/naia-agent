// Slice 2 sub-A — Bash skill (InMemoryToolDef factory).
//
// Pre-execution: assertSafe (DANGEROUS_COMMANDS regex, D01).
// Execution: child_process.execFile("bash", ["-c", command]) with timeout.
// Output: stdout + stderr + exit code (truncated to maxOutputBytes).
//
// Tier T1 by default — local side effects bounded to workspace.
// Wrap with GatedToolExecutor in production hosts (matrix A05).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InMemoryToolDef } from "../mocks/in-memory-tool-executor.js";
import { assertSafe, DangerousCommandError } from "../utils/dangerous-commands.js";
import type { Logger } from "@nextain/agent-types";

const exec = promisify(execFile);

export interface BashSkillOptions {
  logger?: Logger;
  /** Shell to invoke. Defaults to /bin/bash. */
  shell?: string;
  /** Working directory. Default: process.cwd() at call time. */
  cwd?: string;
  /** Max wall time in ms. Default: 30_000 (30s). */
  timeoutMs?: number;
  /** Truncate stdout/stderr to this many bytes total. Default: 32_768 (32 KB). */
  maxOutputBytes?: number;
  /** Tier label (default T1). T2+ should be gated behind ApprovalBroker. */
  tier?: "T0" | "T1" | "T2" | "T3";
  /** Whether to include stderr in result content. Default true. */
  includeStderr?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<BashSkillOptions, "cwd" | "logger">> = {
  shell: "/bin/bash",
  timeoutMs: 30_000,
  maxOutputBytes: 32_768,
  tier: "T1",
  includeStderr: true,
};

export interface BashInput {
  command: string;
}

/**
 * Create the `bash` tool definition. Register in your InMemoryToolExecutor:
 *   const tools = new InMemoryToolExecutor([createBashSkill()]);
 *
 * LLM sees:
 *   { name: "bash", description: "...", inputSchema: { command: string } }
 *
 * On execute: validates against DANGEROUS_COMMANDS regex; throws
 * DangerousCommandError if blocked. Otherwise spawns the shell.
 */
export function createBashSkill(opts: BashSkillOptions = {}): InMemoryToolDef {
  const cfg = { ...DEFAULT_OPTIONS, ...opts };
  const cwd = opts.cwd;

  return {
    name: "bash",
    description:
      "Execute a bash command in the workspace. Returns stdout (and stderr if non-empty) and exit code. " +
      "Dangerous patterns (rm -rf /, fork bomb, dd to disk, sudo + destructive ops, curl|bash, etc.) " +
      "are pre-blocked. Use multiple invocations for chained pipelines.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to execute. Single-line. Pipes and redirects allowed unless dangerous.",
        },
      },
      required: ["command"],
    } as Record<string, unknown>,
    tier: cfg.tier,
    isDestructive: true,
    isConcurrencySafe: false,
    handler: async (input) => {
      const { command } = input as BashInput;
      const fn = opts.logger?.fn?.("bash.handler", { commandLen: typeof command === "string" ? command.length : 0 });
      if (typeof command !== "string" || command.trim().length === 0) {
        fn?.branch("invalid-command");
        return fn?.exit("ERROR: bash skill requires a non-empty `command` string.") ?? "ERROR: bash skill requires a non-empty `command` string.";
      }

      try {
        assertSafe(command);
      } catch (e) {
        if (e instanceof DangerousCommandError) {
          fn?.branch("dangerous-blocked", { reasons: e.reasons });
          opts.logger?.warn("security.dangerous_blocked", {
            commandPrefix: command.slice(0, 60),
            reasons: e.reasons,
          });
          return fn?.exit(`BLOCKED: ${e.message}`) ?? `BLOCKED: ${e.message}`;
        }
        throw e;
      }

      try {
        fn?.branch("exec-start", { shell: cfg.shell, timeoutMs: cfg.timeoutMs });
        const { stdout, stderr } = await exec(cfg.shell, ["-c", command], {
          cwd: cwd ?? process.cwd(),
          timeout: cfg.timeoutMs,
          maxBuffer: cfg.maxOutputBytes,
          encoding: "utf8",
        });
        const out = formatOutput(stdout, stderr, 0, cfg);
        return fn?.exit(out.slice(0, 80)) ? out : out;
      } catch (err) {
        // execFile error: includes stdout/stderr/code on most failures.
        const e = err as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        if (e.killed && e.signal === "SIGTERM") {
          fn?.branch("timeout");
          const msg = `TIMEOUT: command exceeded ${cfg.timeoutMs}ms`;
          return fn?.exit(msg) ?? msg;
        }
        const code = typeof e.code === "number" ? e.code : -1;
        fn?.branch("non-zero-exit", { code });
        const out = formatOutput(e.stdout ?? "", e.stderr ?? e.message, code, cfg);
        return fn?.exit(out.slice(0, 80)) ? out : out;
      }
    },
  };
}

function formatOutput(
  stdout: string,
  stderr: string,
  code: number,
  cfg: Required<Omit<BashSkillOptions, "cwd" | "logger">>,
): string {
  const out = stdout.trim();
  const err = stderr.trim();
  const parts: string[] = [];
  if (out) parts.push(out);
  if (err && cfg.includeStderr) parts.push(`[stderr] ${err}`);
  parts.push(`[exit ${code}]`);
  let combined = parts.join("\n");
  if (combined.length > cfg.maxOutputBytes) {
    combined = combined.slice(0, cfg.maxOutputBytes) + `\n[truncated to ${cfg.maxOutputBytes} bytes]`;
  }
  return combined;
}
