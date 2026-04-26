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

import { access as fsAccess } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ShellAdapter } from "@nextain/agent-adapter-shell";
import { OpencodeRunAdapter } from "@nextain/agent-adapter-opencode-cli";
import { OpencodeAcpAdapter } from "@nextain/agent-adapter-opencode-acp";
import { ChokidarWatcher } from "@nextain/agent-workspace";
import { TestVerifier, TypeCheckVerifier } from "@nextain/agent-verification";
import {
  AutoDenyApprovalBroker,
  CliApprovalBroker,
  InterruptManager,
  Phase1Supervisor,
  runCli,
} from "@nextain/agent-cli-app";
import type { ApprovalBroker, SubAgentAdapter, Verifier } from "@nextain/agent-types";

// D37 — sensitive env var blacklist (--secure-env)
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^GOOGLE_/,
  /^GEMINI_/,
  /^AWS_/,
  /^GITHUB_/,
  /^GH_/,
  /^GITLAB_/,
  /^OPENROUTER_/,
  /^GLM_/,
  /^ZAI_/,
  /^STRIPE_/,
  /^TWILIO_/,
  /^SENTRY_/,
  /^DATABASE_URL$/,
  /_TOKEN$/,
  /_SECRET$/,
  /_PASSWORD$/,
  /_API_KEY$/,
];

interface Args {
  prompt: string;
  workdir: string;
  noVerify: boolean;
  debug: boolean;
  adapter: "opencode-cli" | "opencode-acp" | "shell";
  shellCommand?: string;
  shellArgs: string[];
  model?: string;
  acp: boolean;
  showDiff: boolean;
  secureEnv: boolean;
  autoApprove: boolean;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = {
    prompt: "",
    workdir: process.cwd(),
    noVerify: false,
    debug: false,
    adapter: "opencode-cli",
    shellArgs: [],
    acp: false,
    showDiff: false,
    secureEnv: false,
    autoApprove: false,
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
    } else if (a === "--show-diff") {
      args.showDiff = true;
    } else if (a === "--secure-env") {
      args.secureEnv = true;
    } else if (a === "--auto-approve") {
      args.autoApprove = true; // testing only — never use in production
    } else if (a === "--acp") {
      args.acp = true;
      args.adapter = "opencode-acp";
    } else if (a === "--no-acp") {
      args.acp = false;
      args.adapter = "opencode-cli";
    } else if (a === "--adapter") {
      const v = argv[++i];
      if (v === "opencode-cli" || v === "opencode-acp" || v === "shell") {
        args.adapter = v as Args["adapter"];
        args.acp = v === "opencode-acp";
      } else {
        return { error: `--adapter must be opencode-cli|opencode-acp|shell` };
      }
    } else if (a === "-m" || a === "--model") {
      args.model = argv[++i];
    } else if (a === "--") {
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
  // Paranoid P0-5 — --secure-env + --acp incompatible (opencode needs LLM creds)
  if (args.secureEnv && args.acp) {
    process.stderr.write(
      `naia-agent: warning — --secure-env + --acp incompatible (opencode requires LLM creds in env). Falling back to --no-acp.\n`,
    );
    args.acp = false;
    args.adapter = "opencode-cli";
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

function scrubEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

function buildAdapter(a: Args): SubAgentAdapter {
  if (a.adapter === "shell") {
    return new ShellAdapter({
      command: a.shellCommand ?? "/usr/bin/env",
      args: () => a.shellArgs,
    });
  }
  if (a.adapter === "opencode-acp") {
    return new OpencodeAcpAdapter();
  }
  return new OpencodeRunAdapter({
    ...(a.model !== undefined && { model: a.model }),
    skipPermissions: !a.acp, // ACP mode uses ApprovalBroker; CLI mode skips
  });
}

function buildVerifiers(): readonly Verifier[] {
  return [new TestVerifier(), new TypeCheckVerifier()];
}

function buildApprovalBroker(a: Args): ApprovalBroker | undefined {
  if (a.adapter === "shell" || a.adapter === "opencode-cli") return undefined;
  if (a.autoApprove) {
    // Day 5.4 — E2E automation via stdin pipe (Paranoid P0-11)
    // Note: in real use this is replaced by CliApprovalBroker.
    return new (class implements ApprovalBroker {
      async decide(): Promise<{ status: "approved"; at: number }> {
        return { status: "approved", at: Date.now() };
      }
    })();
  }
  if (process.stdin.isTTY) {
    return new CliApprovalBroker();
  }
  return new AutoDenyApprovalBroker(); // non-interactive default
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

  // D37 — secure-env mode scrubs sensitive env from child env
  if (parsed.secureEnv) {
    const scrubbed = scrubEnv();
    process.env = scrubbed; // affects subsequent spawn() calls
    process.stderr.write(`naia-agent: --secure-env active (sensitive env scrubbed)\n`);
  }

  const adapter = buildAdapter(parsed);
  const watcher = new ChokidarWatcher({ usePolling: false });

  // verification UX — workdir에 package.json 없으면 자동 skip + warn
  // (사용자 environment 보호; --no-verify 명시 시도 동일 효과)
  let effectiveNoVerify = parsed.noVerify;
  if (!effectiveNoVerify) {
    try {
      const pkgPath = path.resolve(parsed.workdir, "package.json");
      await fsAccess(pkgPath);
    } catch {
      process.stderr.write(
        `naia-agent: workdir lacks package.json — skipping verification\n`,
      );
      effectiveNoVerify = true;
    }
  }
  const verifiers = effectiveNoVerify ? [] : buildVerifiers();
  const approvalBroker = buildApprovalBroker(parsed);

  const supervisor = new Phase1Supervisor({
    adapter,
    watcher,
    verifiers,
    noVerify: effectiveNoVerify,
    verificationTimeoutMs: 60_000,
    showDiff: parsed.showDiff,
    ...(approvalBroker !== undefined && { approvalBroker }),
  });

  // Phase 2 D21 — InterruptManager replaces inline SIGINT (Paranoid P2-1 debounce)
  const im = new InterruptManager().install();

  const stream = supervisor.run(parsed.prompt, parsed.workdir, im.signal);
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
