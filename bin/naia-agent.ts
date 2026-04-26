#!/usr/bin/env -S pnpm exec tsx
/**
 * bin/naia-agent — R4 Phase 1 entry.
 *
 * Hybrid wrapper CLI: spawns opencode (or shell fallback) as a sub-agent,
 * watches workspace, runs post-task verification, prints honest numeric report.
 *
 * Usage:
 *   pnpm naia-agent "<prompt>"                       # default opencode CLI
 *   pnpm naia-agent "<prompt>" --workdir /path       # specify workdir (default cwd)
 *   pnpm naia-agent "<prompt>" --no-verify           # skip pnpm test/typecheck
 *   pnpm naia-agent "<prompt>" --adapter shell -- echo "x"   # use shell fallback
 *   pnpm naia-agent "<prompt>" -m provider/model     # opencode model selection
 *   pnpm naia-agent "<prompt>" --debug               # print every chunk type
 *
 * Exit codes:
 *   0 — task ok, all verifications PASS
 *   1 — task ok but verification FAIL
 *   2 — sub-agent failed
 *   3 — usage error
 *
 * R3 modes (REPL / stdin / anthropic-direct LLM call) are removed —
 * naia-agent is now a sub-agent supervisor (R4 D18 Hybrid wrapper).
 * R3 examples remain in git history (commit before 2026-04-26).
 */

import process from "node:process";
import { ShellAdapter } from "@nextain/agent-adapter-shell";
import { OpencodeRunAdapter } from "@nextain/agent-adapter-opencode-cli";
import { ChokidarWatcher } from "@nextain/agent-workspace";
import { TestVerifier, TypeCheckVerifier } from "@nextain/agent-verification";
import { Phase1Supervisor, runCli } from "@nextain/agent-cli-app";
import type { SubAgentAdapter, Verifier } from "@nextain/agent-types";

interface Args {
  prompt: string;
  workdir: string;
  noVerify: boolean;
  debug: boolean;
  adapter: "opencode-cli" | "shell";
  shellCommand?: string;
  shellArgs: string[];
  model?: string;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = {
    prompt: "",
    workdir: process.cwd(),
    noVerify: false,
    debug: false,
    adapter: "opencode-cli",
    shellArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--workdir") {
      const v = argv[++i];
      if (!v) return { error: "--workdir requires a value" };
      args.workdir = v;
    } else if (a === "--no-verify") {
      args.noVerify = true;
    } else if (a === "--debug") {
      args.debug = true;
    } else if (a === "--adapter") {
      const v = argv[++i];
      if (v === "opencode-cli" || v === "shell") args.adapter = v;
      else return { error: `--adapter must be opencode-cli|shell` };
    } else if (a === "-m" || a === "--model") {
      args.model = argv[++i];
    } else if (a === "--") {
      // remaining args go to shell adapter
      args.shellArgs = argv.slice(i + 1);
      break;
    } else if (!a.startsWith("-") && args.prompt.length === 0) {
      args.prompt = a;
    } else {
      return { error: `unknown arg: ${a}` };
    }
  }
  if (args.prompt.length === 0) {
    return { error: "prompt required (positional argument)" };
  }
  if (args.adapter === "shell" && args.shellArgs.length === 0) {
    args.shellCommand = "/usr/bin/env";
    args.shellArgs = ["echo", args.prompt];
  } else if (args.adapter === "shell") {
    args.shellCommand = args.shellArgs[0];
    args.shellArgs = args.shellArgs.slice(1);
  }
  return args;
}

function buildAdapter(a: Args): SubAgentAdapter {
  if (a.adapter === "shell") {
    return new ShellAdapter({
      command: a.shellCommand ?? "/usr/bin/env",
      args: () => a.shellArgs,
    });
  }
  return new OpencodeRunAdapter({
    ...(a.model !== undefined && { model: a.model }),
    skipPermissions: true, // Phase 1 — interactive approval is Phase 2
  });
}

function buildVerifiers(): readonly Verifier[] {
  return [new TestVerifier(), new TypeCheckVerifier()];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`naia-agent: ${parsed.error}\n`);
    process.stderr.write(
      `usage: pnpm naia-agent "<prompt>" [--workdir DIR] [--no-verify] [-m model] [--adapter shell -- cmd args] [--debug]\n`,
    );
    return 3;
  }

  const adapter = buildAdapter(parsed);
  const watcher = new ChokidarWatcher({ usePolling: false });
  const verifiers = parsed.noVerify ? [] : buildVerifiers();

  const supervisor = new Phase1Supervisor({
    adapter,
    watcher,
    verifiers,
    noVerify: parsed.noVerify,
    verificationTimeoutMs: 60_000,
  });

  const ac = new AbortController();
  process.on("SIGINT", () => {
    process.stderr.write("\n[알파] interrupt — cancelling\n");
    ac.abort("user-SIGINT");
  });

  const stream = supervisor.run(parsed.prompt, parsed.workdir, ac.signal);
  return runCli(stream, {
    prompt: parsed.prompt,
    workdir: parsed.workdir,
    noVerify: parsed.noVerify,
    debug: parsed.debug,
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`naia-agent: fatal: ${(err as Error).message}\n`);
    process.exit(2);
  },
);
