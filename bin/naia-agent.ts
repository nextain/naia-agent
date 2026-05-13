#!/usr/bin/env -S pnpm exec tsx
/**
 * bin/naia-agent — R5 entry point.
 *
 * Default mode (--mode=direct, default):
 *   Agent(HostContext) → VercelClient → LLM directly.
 *   TTY stdin:    readline REPL loop  (type 'exit' or 'quit' to quit)
 *   Piped stdin:  single-shot from positional arg or piped stdin
 *
 * Supervisor mode (--mode=supervisor):
 *   Phase1Supervisor wrapping opencode-cli/shell sub-agent.
 *   Kept for backward compatibility.
 *
 * Usage:
 *   pnpm naia-agent "hello"                      # direct, single-shot
 *   pnpm naia-agent                              # direct, REPL (TTY)
 *   pnpm naia-agent "task" --mode=supervisor     # supervisor (opencode)
 *   pnpm naia-agent "task" --workdir /path       # workdir
 *   pnpm naia-agent "task" --no-verify           # skip test/typecheck (supervisor)
 *   pnpm naia-agent "task" --adapter shell -- echo "x"  # shell sub-agent
 *   pnpm naia-agent "task" -m provider/model     # model (supervisor)
 *   pnpm naia-agent "task" --debug               # verbose event log
 *
 * Provider resolution (direct mode, first match wins):
 *   1. ANTHROPIC_API_KEY  → claude-haiku-4-5-20251001 (or ANTHROPIC_MODEL)
 *   2. OPENAI_API_KEY + OPENAI_BASE_URL → OPENAI_MODEL (default glm-4.5-flash)
 *   3. GLM_API_KEY        → glm-4.5-flash (or GLM_MODEL)
 *   4. VERTEX_PROJECT_ID + VERTEX_REGION → claude-haiku-4-5-20251001
 *   5. (none)             → MockLLMClient (warns, for tests only)
 *
 * Exit codes: 0 = ok, 1 = verif fail, 2 = runtime error, 3 = usage error
 * See: docs/llm-config-standard.md
 */

import readline from "node:readline";
import { access as fsAccess } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Agent } from "@nextain/agent-core";
import type { HostContext, LLMClient } from "@nextain/agent-types";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
import {
  InMemoryMemory,
  InMemoryToolExecutor,
  createBashSkill,
} from "@nextain/agent-runtime";
import { VercelClient } from "@nextain/agent-providers";


// Supervisor mode imports
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

// ─── Sensitive env var blacklist (D37 / #23) ────────────────────────────────
// Used by --secure-env to scrub child process env (NOT applied to this process)
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^GOOGLE_/,
  /^GEMINI_/,
  /^AWS_/,
  /^AZURE_/,
  /^GITHUB_/,
  /^GH_/,
  /^GITLAB_/,
  /^OPENROUTER_/,
  /^GLM_/,
  /^ZAI_/,
  /^STRIPE_/,
  /^TWILIO_/,
  /^SENTRY_/,
  /^VERCEL_/,
  /^DATABASE_URL$/,
  /^PGPASSWORD$/,
  /_TOKEN$/,
  /_SECRET$/,
  /_PASSWORD$/,
  /_API_KEY$/,
];

// ─── Args ────────────────────────────────────────────────────────────────────

type Mode = "direct" | "supervisor";

interface Args {
  mode: Mode;
  prompt: string;
  workdir: string;
  // direct mode
  systemPrompt?: string;
  debug: boolean;
  // supervisor mode
  noVerify: boolean;
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
    mode: "direct",
    prompt: "",
    workdir: process.cwd(),
    debug: false,
    noVerify: false,
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
    if (a === "--mode=direct") {
      args.mode = "direct";
    } else if (a === "--mode=supervisor") {
      args.mode = "supervisor";
    } else if (a === "--workdir") {
      const v = argv[++i];
      if (!v) return { error: "--workdir requires a value" };
      args.workdir = v;
    } else if (a === "--system") {
      const v = argv[++i];
      if (!v) return { error: "--system requires a value" };
      args.systemPrompt = v;
    } else if (a === "--no-verify") {
      args.noVerify = true;
    } else if (a === "--debug") {
      args.debug = true;
    } else if (a === "--show-diff") {
      args.showDiff = true;
    } else if (a === "--secure-env") {
      args.secureEnv = true;
    } else if (a === "--auto-approve") {
      args.autoApprove = true;
    } else if (a === "--acp") {
      args.acp = true;
      args.adapter = "opencode-acp";
      args.mode = "supervisor";
    } else if (a === "--no-acp") {
      args.acp = false;
      args.adapter = "opencode-cli";
    } else if (a === "--adapter") {
      const v = argv[++i];
      if (v === "opencode-cli" || v === "opencode-acp" || v === "shell") {
        args.adapter = v as Args["adapter"];
        args.acp = v === "opencode-acp";
        args.mode = "supervisor";
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

  // prompt is required only in supervisor mode and non-TTY direct mode
  if (args.mode === "supervisor" && args.prompt.length === 0) {
    return { error: "prompt required (positional argument)" };
  }

  if (args.secureEnv && args.acp) {
    process.stderr.write(
      `naia-agent: warning — --secure-env + --acp incompatible. Falling back to --no-acp.\n`,
    );
    args.acp = false;
    args.adapter = "opencode-cli";
  }

  if (args.adapter === "shell" && args.shellArgs.length === 0) {
    args.shellCommand = process.platform === "win32" ? "cmd.exe" : "/usr/bin/env";
    args.shellArgs = process.platform === "win32" ? ["/c", "echo", args.prompt] : ["echo", args.prompt];
  } else if (args.adapter === "shell") {
    args.shellCommand = args.shellArgs[0];
    args.shellArgs = args.shellArgs.slice(1);
  }

  return args;
}

// ─── Provider resolution (direct mode) ──────────────────────────────────────

async function buildLLMClient(): Promise<LLMClient | null> {
  const env = process.env;

  if (env.ANTHROPIC_API_KEY) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const model = env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    const anthropic = createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL && { baseURL: env.ANTHROPIC_BASE_URL }),
    });
    process.stderr.write(`naia-agent: provider=anthropic model=${model}\n`);
    return new VercelClient(anthropic(model));
  }

  if (env.OPENAI_API_KEY && env.OPENAI_BASE_URL) {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const model = env.OPENAI_MODEL ?? "glm-4.5-flash";
    const provider = createOpenAICompatible({
      name: "openai-compat",
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
    });
    process.stderr.write(`naia-agent: provider=openai-compat model=${model}\n`);
    return new VercelClient(provider.chatModel(model));
  }

  if (env.GLM_API_KEY) {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const model = env.GLM_MODEL ?? "glm-4.5-flash";
    const baseURL = env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
    const provider = createOpenAICompatible({
      name: "zhipu-glm",
      apiKey: env.GLM_API_KEY,
      baseURL,
    });
    process.stderr.write(`naia-agent: provider=glm model=${model}\n`);
    return new VercelClient(provider.chatModel(model));
  }

  if (env.VERTEX_PROJECT_ID && env.VERTEX_REGION) {
    const { createVertex } = await import("@ai-sdk/google");
    const project = env.VERTEX_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? "";
    const region = env.VERTEX_REGION ?? env.GOOGLE_CLOUD_LOCATION ?? "us-east5";
    const model = env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    const vertex = createVertex({ project, location: region });
    process.stderr.write(`naia-agent: provider=vertex model=${model}\n`);
    return new VercelClient(vertex(model));
  }

  process.stderr.write(
    `naia-agent: ERROR — no LLM provider configured.\n` +
    `  Set ANTHROPIC_API_KEY, GLM_API_KEY, or OPENAI_API_KEY+OPENAI_BASE_URL.\n` +
    `  See: docs/llm-config-standard.md\n`,
  );
  return null;
}

function buildScrubbed(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

// ─── Direct mode ─────────────────────────────────────────────────────────────

async function runDirect(args: Args): Promise<number> {
  const llm = await buildLLMClient();
  if (!llm) return 3;
  const tools = new InMemoryToolExecutor([createBashSkill()]);
  const memory = new InMemoryMemory();
  const logger = new ConsoleLogger({ level: args.debug ? "debug" : "warn" });

  const host: HostContext = {
    llm,
    memory,
    tools,
    logger,
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
    approvals: {
      async decide() {
        throw new Error("naia-agent: tool approval not wired (direct mode)");
      },
    },
    identity: {
      deviceId: "naia-agent-cli",
      publicKeyEd25519: "cli",
      async sign() {
        throw new Error("naia-agent: sign() not wired");
      },
    },
  };

  const agent = new Agent({
    host,
    systemPrompt: args.systemPrompt,
    tierForTool: () => "T1",
  });

  if (args.prompt.length > 0) {
    // Single-shot mode (prompt from argv or non-TTY pipe)
    await streamToStdout(agent, args.prompt, args.debug);
    agent.close();
    return 0;
  }

  // REPL mode — requires TTY
  if (!process.stdin.isTTY) {
    // Read single prompt from stdin
    const piped = await readStdin();
    if (piped.trim().length === 0) {
      process.stderr.write("naia-agent: no prompt (stdin empty and no positional arg)\n");
      return 3;
    }
    await streamToStdout(agent, piped.trim(), args.debug);
    agent.close();
    return 0;
  }

  // Interactive REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nnaia> ",
    terminal: true,
  });

  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ".exit") break;
    if (trimmed.length === 0) {
      rl.prompt();
      continue;
    }
    await streamToStdout(agent, trimmed, args.debug);
    rl.prompt();
  }

  rl.close();
  agent.close();
  return 0;
}

async function streamToStdout(agent: Agent, prompt: string, debug: boolean): Promise<void> {
  for await (const ev of agent.sendStream(prompt)) {
    if (ev.type === "llm.chunk") {
      if (ev.chunk.type === "content_block_delta" && ev.chunk.delta.type === "text_delta") {
        process.stdout.write(ev.chunk.delta.text);
      }
    } else if (ev.type === "turn.ended") {
      process.stdout.write("\n");
    } else if (ev.type === "tool.started") {
      process.stderr.write(`[tool] ${ev.invocation.name}(${JSON.stringify(ev.invocation.input).slice(0, 120)})\n`);
    } else if (ev.type === "tool.ended") {
      if (debug) {
        process.stderr.write(`[tool ◀] ${ev.invocation.name} → ${String(ev.result.content).slice(0, 120)}\n`);
      }
    } else if (ev.type === "compaction") {
      if (debug) process.stderr.write(`[compact] dropped=${ev.droppedCount}\n`);
    } else if (debug) {
      process.stderr.write(`[${ev.type}]\n`);
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

// ─── Supervisor mode ─────────────────────────────────────────────────────────

function buildSupervisorAdapter(a: Args): SubAgentAdapter {
  if (a.adapter === "shell") {
    return new ShellAdapter({
      command: a.shellCommand ?? (process.platform === "win32" ? "cmd.exe" : "/usr/bin/env"),
      args: () => a.shellArgs,
    });
  }
  if (a.adapter === "opencode-acp") {
    return new OpencodeAcpAdapter();
  }
  return new OpencodeRunAdapter({
    ...(a.model !== undefined && { model: a.model }),
    skipPermissions: !a.acp,
  });
}

function buildSupervisorApprovalBroker(a: Args): ApprovalBroker | undefined {
  if (a.adapter === "shell" || a.adapter === "opencode-cli") return undefined;
  if (a.autoApprove) {
    return new (class implements ApprovalBroker {
      async decide(): Promise<{ status: "approved"; at: number }> {
        return { status: "approved", at: Date.now() };
      }
    })();
  }
  if (process.stdin.isTTY) return new CliApprovalBroker();
  return new AutoDenyApprovalBroker();
}

async function runSupervisor(args: Args): Promise<number> {
  const adapter = buildSupervisorAdapter(args);
  const watcher = new ChokidarWatcher({ usePolling: false });

  let effectiveNoVerify = args.noVerify;
  if (!effectiveNoVerify) {
    try {
      await fsAccess(path.resolve(args.workdir, "package.json"));
    } catch {
      process.stderr.write(`naia-agent: workdir lacks package.json — skipping verification\n`);
      effectiveNoVerify = true;
    }
  }

  const verifiers: readonly Verifier[] = effectiveNoVerify
    ? []
    : [new TestVerifier(), new TypeCheckVerifier()];
  const approvalBroker = buildSupervisorApprovalBroker(args);

  const supervisor = new Phase1Supervisor({
    adapter,
    watcher,
    verifiers,
    noVerify: effectiveNoVerify,
    verificationTimeoutMs: 60_000,
    showDiff: args.showDiff,
    ...(approvalBroker !== undefined && { approvalBroker }),
  });

  const im = new InterruptManager().install();
  const stream = supervisor.run(args.prompt, args.workdir, im.signal);
  return runCli(stream, {
    prompt: args.prompt,
    workdir: args.workdir,
    noVerify: args.noVerify,
    debug: args.debug,
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`naia-agent: ${parsed.error}\n`);
    process.stderr.write(
      `usage: pnpm naia-agent [prompt] [--mode=direct|supervisor] [--workdir DIR] [--debug]\n` +
      `       pnpm naia-agent [prompt] --mode=supervisor [--no-verify] [-m model] [--adapter shell -- cmd args]\n`,
    );
    return 3;
  }

  if (parsed.mode === "supervisor") {
    return runSupervisor(parsed);
  }

  return runDirect(parsed);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`naia-agent: fatal: ${(err as Error).message}\n`);
    process.exit(2);
  },
);
