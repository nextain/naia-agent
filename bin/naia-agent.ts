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
 *   pnpm naia-agent "hi" --service app.service.json  # R6/SB-1 manifest (#32, §D50)
 *   pnpm naia-agent --stdio                         # JSON-line IPC mode (naia-os bridge)
 *   pnpm naia-agent login --key anthropic          # save API key → ~/.naia-agent/.env
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
import { spawnSync } from "node:child_process";
import { access as fsAccess, readFile, writeFile, mkdir, readdir, chmod } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { Agent, stripRecallResidue } from "@nextain/agent-core";
import type { HostContext, LLMClient, MemoryProvider, ToolExecutor } from "@nextain/agent-types";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
import {
  InMemoryMemory,
  InMemoryToolExecutor,
  createBashSkill,
  createFileOpsSkills,
  createTimeSkill,
  createWeatherSkill,
  createMemoSkill,
  createSystemStatusSkill,
  createDiagnosticsSkill,
  createSessionsSkill,
  createConfigSkill,
  SessionManager,
  ConfigManager,
  FileSkillLoader,
  SkillToolExecutor,
  CompositeToolExecutor,
  parseServiceManifest,
  resolveMemoryBinding,
  manifestBaseURLTrust,
  manifestInvalid,
  parseEnv,
  loadEnvAndConfig,
  checkDuplicateKeys,
  buildEnvAppend,
  getSecretStore,
  parseRoleSpec,
  readConfiguredAdkPath,
  decideCliMemory,
} from "@nextain/agent-runtime";
import type { ServiceManifest, ParsedRole } from "@nextain/agent-runtime";
// Composition root may depend on a MemoryProvider implementation (the
// runtime/core packages must not). Blessed pattern: examples/naia-memory-host.
import { LiteMemoryProvider, OpenAICompatEmbeddingProvider } from "@nextain/naia-memory";
import { VercelClient } from "@nextain/agent-providers";


// Supervisor mode imports
import { ShellAdapter } from "@nextain/agent-adapter-shell";
import { OpencodeRunAdapter } from "@nextain/agent-adapter-opencode-cli";
import { OpencodeAcpAdapter } from "@nextain/agent-adapter-opencode-acp";
import { PiRunAdapter } from "@nextain/agent-adapter-pi";
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

const PROCESS_STARTED_AT = Date.now();
const sessionManager = new SessionManager();
const configManager = new ConfigManager();

// ─── Args ────────────────────────────────────────────────────────────────────

type Mode = "direct" | "supervisor";

interface Args {
  mode: Mode;
  prompt: string;
  workdir: string;
  /** JSON-line IPC mode — implements naia-os embedded agent protocol on stdin/stdout. */
  stdio: boolean;
  // direct mode
  systemPrompt?: string;
  /** R6/SB-1 (#32, §D50) — path to a *.service.json manifest. Implies direct
   *  mode; llm/memory/persona are assembled from the manifest, not env. */
  service?: string;
  debug: boolean;
  // supervisor mode
  noVerify: boolean;
  adapter: "opencode-cli" | "opencode-acp" | "shell" | "pi";
  shellCommand?: string;
  shellArgs: string[];
  model?: string;
  acp: boolean;
  showDiff: boolean;
  secureEnv: boolean;
  autoApprove: boolean;
  /** Attach no tools to the Agent. Needed for models without native
   *  tool-calling (e.g. local Ollama gemma3n). Model-agnostic. */
  noTools: boolean;
  /** Omit the built-in DEFAULT_SYSTEM_PROMPT behavioral contract. Small
   *  models are degraded by the long English contract (#41 v2, measured).
   *  Model-agnostic — any host with its own prompt / tight budget. */
  noDefaultSystem: boolean;
  /** Use the persistent LiteMemoryProvider (naia-settings `embedded`
   *  embedder) + #41 `<recall>` marker recall instead of ephemeral
   *  InMemoryMemory. Opt-in — default off (no behavior change). */
  memory: boolean;
  /** Register the read/write/edit/list file-ops skills in addition to
   *  bash. Opt-in — default off (no behavior change). Model-agnostic
   *  toggle; any native-tool-calling model can drive them
   *  (cf. createFileOpsSkills in @nextain/agent-runtime/skills). */
  enableFileOps: boolean;
  /** Load skills from an external ADK directory (e.g. naia-adk/skills/
   *  or onmam-adk/skills/) via FileSkillLoader. The path is treated as
   *  the direct skills root containing `<name>/SKILL.md` entries.
   *  Composes with bash + (optional) file-ops via CompositeToolExecutor.
   *  Slice 3-XR-J — default OFF. */
  skillsDir?: string;
  /** Force interactive REPL mode regardless of stdin TTY status. Default
   *  behavior treats piped stdin as single-shot (read full stdin →
   *  one turn). With `--repl`, the bin enters the readline loop even
   *  when stdin is piped — useful for harness-driven multi-turn tests
   *  (Slice 3-XR-M) and for shell pipelines that want to feed several
   *  prompts. Model-agnostic toggle. */
  forceRepl: boolean;
  /** Compaction strategy — Slice 3-XR-Compact (#47). Default `reactive`
   *  (anchored iterative head summarization, opencode/openclaw pattern).
   *  See `docs/compaction-survey.md` for `realtime` / `anthropic-native`
   *  / `off` semantics. Env override: `NAIA_AGENT_COMPACT_STRATEGY`. */
  compactStrategy: "reactive" | "realtime" | "anthropic-native" | "off";
  /** Cross-session handoff — Slice 3-XR-Handoff (#50).
   *  Path to write the HandoffBlob (JSON) when the session ends OR
   *  auto-trigger fires (post-compact, budget≥95%). Disabled if undefined. */
  handoffOut?: string;
  /** Path to read a HandoffBlob (JSON) at session start. The blob's recap +
   *  identifier anchors are injected into the first turn's system prompt. */
  handoffIn?: string;
}

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = {
    mode: "direct",
    prompt: "",
    workdir: process.cwd(),
    stdio: false,
    debug: false,
    noVerify: false,
    adapter: "opencode-cli",
    shellArgs: [],
    acp: false,
    showDiff: false,
    secureEnv: false,
    autoApprove: false,
    noTools: false,
    noDefaultSystem: false,
    memory: false,
    enableFileOps: false,
    forceRepl: false,
    compactStrategy: resolveCompactStrategyEnv(),
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
    } else if (a === "--service") {
      const v = argv[++i];
      if (!v) return { error: "--service requires a path to a *.service.json manifest" };
      args.service = v;
      args.mode = "direct";
    } else if (a === "--no-verify") {
      args.noVerify = true;
    } else if (a === "--no-tools") {
      args.noTools = true;
    } else if (a === "--no-default-system") {
      args.noDefaultSystem = true;
    } else if (a === "--memory") {
      args.memory = true;
    } else if (a === "--enable-file-ops") {
      args.enableFileOps = true;
    } else if (a === "--skills-dir") {
      const v = argv[++i];
      if (!v) return { error: "--skills-dir requires a path" };
      args.skillsDir = v;
    } else if (a === "--repl") {
      args.forceRepl = true;
    } else if (a === "--compact-strategy") {
      const v = argv[++i];
      if (!v) {
        return {
          error:
            "--compact-strategy requires a value (reactive|realtime|anthropic-native|off)",
        };
      }
      if (
        v !== "reactive" &&
        v !== "realtime" &&
        v !== "anthropic-native" &&
        v !== "off"
      ) {
        return {
          error: `--compact-strategy: unknown value '${v}'. Allowed: reactive|realtime|anthropic-native|off`,
        };
      }
      args.compactStrategy = v;
    } else if (a === "--handoff-out") {
      const v = argv[++i];
      if (!v) return { error: "--handoff-out requires a path" };
      args.handoffOut = v;
    } else if (a === "--handoff-in") {
      const v = argv[++i];
      if (!v) return { error: "--handoff-in requires a path" };
      args.handoffIn = v;
    } else if (a === "--debug") {
      args.debug = true;
    } else if (a === "--show-diff") {
      args.showDiff = true;
    } else if (a === "--secure-env") {
      args.secureEnv = true;
    } else if (a === "--auto-approve") {
      args.autoApprove = true;
    } else if (a === "--stdio") {
      args.stdio = true;
    } else if (a === "--acp") {
      args.acp = true;
      args.adapter = "opencode-acp";
      args.mode = "supervisor";
    } else if (a === "--no-acp") {
      args.acp = false;
      args.adapter = "opencode-cli";
    } else if (a === "--adapter") {
      const v = argv[++i];
      if (v === "opencode-cli" || v === "opencode-acp" || v === "shell" || v === "pi") {
        args.adapter = v as Args["adapter"];
        args.acp = v === "opencode-acp";
        args.mode = "supervisor";
      } else {
        return { error: `--adapter must be opencode-cli|opencode-acp|shell|pi` };
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

/**
 * Resolve compaction strategy from env. Default `reactive`. Slice 3-XR-Compact
 * (#47). CLI flag `--compact-strategy` overrides this.
 */
function resolveCompactStrategyEnv(): Args["compactStrategy"] {
  const v = process.env.NAIA_AGENT_COMPACT_STRATEGY;
  if (
    v === "reactive" ||
    v === "realtime" ||
    v === "anthropic-native" ||
    v === "off"
  ) {
    return v;
  }
  if (v !== undefined && v.length > 0) {
    process.stderr.write(
      `naia-agent: warning — NAIA_AGENT_COMPACT_STRATEGY='${v}' invalid, using 'reactive'\n`,
    );
  }
  return "reactive";
}

// ─── Provider resolution (direct mode) ──────────────────────────────────────

async function buildLLMClient(overrideModel?: string): Promise<LLMClient | null> {
  const env = process.env;

  // Naia AnyLLM gateway (OpenAI-compatible, takes priority over plain OPENAI_*)
  if (env.NAIA_ANYLLM_API_KEY && env.NAIA_ANYLLM_BASE_URL) {
    const model = overrideModel
      || (env.NAIA_MAIN_MODEL && env.NAIA_MAIN_MODEL !== "auto" ? env.NAIA_MAIN_MODEL : undefined);
    if (!model) {
      process.stderr.write(
        `naia-agent: ERROR — no model specified.\n` +
        `  Use --model <id> or run: pnpm naia-agent login → main LLM → select model\n`,
      );
      return null;
    }
    // naia-*-live local bypass: route directly to local voice wrapper
    const liveHost = env.NAIA_LIVE_HOST;
    if (liveHost && /^naia-omni(-\w+)?$/i.test(model)) {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const provider = createOpenAICompatible({
        name: "naia-talk-local",
        apiKey: "",
        baseURL: liveHost.replace(/\/+$/, ""),
      });
      process.stderr.write(`naia-agent: provider=naia-talk-local model=${model}\n`);
      return new VercelClient(provider.chatModel(model));
    }
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const provider = createOpenAICompatible({
      name: "naia-anyllm",
      apiKey: env.NAIA_ANYLLM_API_KEY,
      baseURL: env.NAIA_ANYLLM_BASE_URL,
    });
    process.stderr.write(`naia-agent: provider=naia model=${model}\n`);
    return new VercelClient(provider.chatModel(model));
  }

  if (env.ANTHROPIC_API_KEY) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const model = overrideModel || env.NAIA_MAIN_MODEL || env.ANTHROPIC_MODEL;
    if (!model) {
      process.stderr.write(`naia-agent: ERROR — no model specified. Use --model <id>\n`);
      return null;
    }
    const anthropic = createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL && { baseURL: env.ANTHROPIC_BASE_URL }),
    });
    process.stderr.write(`naia-agent: provider=anthropic model=${model}\n`);
    return new VercelClient(anthropic(model));
  }

  if (env.OPENAI_BASE_URL) {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const model = overrideModel || env.NAIA_MAIN_MODEL || env.OPENAI_MODEL;
    if (!model) {
      process.stderr.write(`naia-agent: ERROR — no model specified. Use --model <id>\n`);
      return null;
    }
    const provider = createOpenAICompatible({
      name: "openai-compat",
      apiKey: env.OPENAI_API_KEY ?? "",
      baseURL: env.OPENAI_BASE_URL,
    });
    process.stderr.write(`naia-agent: provider=openai-compat model=${model}\n`);
    return new VercelClient(provider.chatModel(model));
  }

  if (env.GLM_API_KEY) {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const model = overrideModel || env.NAIA_MAIN_MODEL || env.GLM_MODEL;
    if (!model) {
      process.stderr.write(`naia-agent: ERROR — no model specified. Use --model <id>\n`);
      return null;
    }
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
    const model = overrideModel || env.ANTHROPIC_MODEL;
    if (!model) {
      process.stderr.write(`naia-agent: ERROR — no model specified. Use --model <id>\n`);
      return null;
    }
    const vertex = createVertex({ project, location: region });
    process.stderr.write(`naia-agent: provider=vertex model=${model}\n`);
    return new VercelClient(vertex(model));
  }

  const naiaMainProvider = env.NAIA_MAIN_PROVIDER || readNaiaSettingsSync()["NAIA_MAIN_PROVIDER"];
  if (naiaMainProvider === "claude-code") {
    try {
      const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
      const provider = createClaudeCode();
      const model = overrideModel || env.NAIA_MAIN_MODEL || "sonnet";
      process.stderr.write(`naia-agent: provider=claude-code model=${model} (subscription)\n`);
      return new VercelClient(provider(model as Parameters<typeof provider>[0]));
    } catch {
      process.stderr.write(
        `naia-agent: ERROR — Claude Code SDK not available. Install: npm install -g @anthropic-ai/claude-code && claude login\n`,
      );
      return null;
    }
  }

  process.stderr.write(
    `naia-agent: ERROR — no LLM provider configured.\n` +
    `  Quickest path: pnpm naia-agent login --adk <naia-adk-path> --main "provider|baseUrl|model"\n` +
    `  Or set an env var: ANTHROPIC_API_KEY, GLM_API_KEY, or OPENAI_API_KEY+OPENAI_BASE_URL.\n` +
    `  See: docs/llm-config-standard.md, docs/user-guide.md\n`,
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

/** Default persona for `--memory`: teaches the #41 v2 recall protocol.
 *  Language-NEUTRAL (cross-review F3 — naia-agent is general-purpose; no
 *  output-language is commanded, the model mirrors the user). */
const MEMORY_PERSONA =
  "You are naia, an assistant with persistent long-term memory. " +
  "When asked about the user's past or personal information (preferences, " +
  "names, plans, …), do not guess — output exactly one line: " +
  String.raw`<recall>query</recall>` + ". When memory is injected, answer naturally " +
  "using it. Answer general knowledge and the ongoing conversation " +
  "directly. Reply in the user's language; be concise.";

/**
 * CLI memory provider. `--memory` → persistent LiteMemoryProvider with the
 * naia-settings `embedded` embedder (blessed naia-memory components). Any
 * failure degrades gracefully to ephemeral InMemoryMemory (anchor #6 —
 * never crash the CLI over memory). Default (no `--memory`) = unchanged.
 */
function buildCliMemory(args: Args): MemoryProvider {
  if (!args.memory) return new InMemoryMemory();
  const d = decideCliMemory(process.env); // pure: gate + /v1 normalization
  if (d.kind === "ephemeral") {
    process.stderr.write(`naia-agent: ${d.reason} — falling back to ephemeral memory.\n`);
    return new InMemoryMemory();
  }
  try {
    const embedBase = d.base as string;
    // Embed key: explicit env wins; else the `ollama` dummy ONLY for a
    // loopback/private endpoint (cross-review F2 — symmetric with the chat
    // sentinel; a real remote w/o key gets "" → honest 401, not a
    // misleading dummy-auth). manifestBaseURLTrust is the same general gate.
    const explicitKey = process.env["NAIA_EMBED_API_KEY"];
    const embedKey =
      explicitKey ?? (manifestBaseURLTrust(embedBase, process.env).ok ? "ollama" : "");
    const embedder = new OpenAICompatEmbeddingProvider(
      embedBase,
      embedKey,
      d.model as string,
      d.dims as number,
    );
    const dbPath =
      process.env["NAIA_AGENT_MEMORY_DB"] ??
      path.join(homedir(), ".naia-agent", "memory", "cli.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    process.stderr.write(
      `naia-agent: memory=lite db=${dbPath} embed=${d.model}\n`,
    );
    return new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
  } catch (e) {
    process.stderr.write(
      `naia-agent: memory init failed (${(e as Error).message}) — ephemeral fallback.\n`,
    );
    return new InMemoryMemory();
  }
}

async function runDirect(args: Args): Promise<number> {
  // Slice 3-XR-Handoff (#50) — read + parse handoff-in BEFORE the LLM check
  // so file-shape errors surface even when no provider is configured.
  // The parsed blob is passed to agent.importHandoff() once the agent exists.
  let importedHandoffBlob: unknown = undefined;
  if (args.handoffIn !== undefined) {
    try {
      const raw = await readFile(args.handoffIn, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { version?: unknown }).version === 1
      ) {
        importedHandoffBlob = parsed;
      } else {
        process.stderr.write(
          `naia-agent: --handoff-in ${args.handoffIn} — not a valid HandoffBlob (version!=1), skipping\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `naia-agent: --handoff-in ${args.handoffIn} — read failed: ${err instanceof Error ? err.message : String(err)} (continuing without import)\n`,
      );
    }
  }

  const llm = await buildLLMClient(args.model);
  if (!llm) return 3;

  // Test-only hermetic provider gate. Same pattern as runService DRYRUN.
  // Proves provider was configured (env-loader wiring) without any LLM call.
  if (process.env.NAIA_AGENT_DRYRUN === "1") {
    process.stderr.write(`naia-agent: dry-run OK (direct mode — provider configured)\n`);
    return 0;
  }

  const builtinSkills = args.noTools
    ? []
    : [
        createBashSkill(),
        createTimeSkill(),
        createWeatherSkill(),
        createSystemStatusSkill(),
        createMemoSkill(),
        createDiagnosticsSkill({ sessionManager, configManager, startedAt: PROCESS_STARTED_AT }),
        createSessionsSkill({ sessionManager }),
        createConfigSkill({ configManager }),
        ...(args.enableFileOps ? createFileOpsSkills({ workspaceRoot: args.workdir }) : []),
      ];
  const inMemTools = new InMemoryToolExecutor(builtinSkills);
  const adkAutoSkillDirs: string[] = [];
  const adkBase = resolveAdkPath();
  for (const sub of [".agents/skills", "skills"]) {
    const candidate = path.join(adkBase, sub);
    if (existsSync(candidate)) adkAutoSkillDirs.push(candidate);
  }
  const allSkillDirs = [...(args.skillsDir ? [args.skillsDir] : []), ...adkAutoSkillDirs];

  let tools: ToolExecutor;
  if (allSkillDirs.length > 0) {
    const skillSubs = allSkillDirs.map((dir, i) => ({
      id: `adk-skills-${i}`,
      executor: new SkillToolExecutor({
        loader: new FileSkillLoader({
          workspaceRoot: dir,
          skillsDir: dir,
          onWarn: (m: string) => process.stderr.write(`naia-agent: skills-dir warn: ${m}\n`),
        }),
      }),
    }));
    tools = new CompositeToolExecutor({ subs: [{ id: "builtins", executor: inMemTools }, ...skillSubs] });
  } else {
    tools = inMemTools;
  }
  const memory = buildCliMemory(args);
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
    // --memory with no explicit --system → the recall-protocol persona so
    // the marker actually fires (otherwise memory is never exercised).
    systemPrompt: args.systemPrompt ?? (args.memory ? MEMORY_PERSONA : undefined),
    tierForTool: () => "T1",
    // --memory defaults to lean (the heavy contract degrades small models
    // AND dilutes the recall instruction — #41 v2 measured); explicit
    // --no-default-system always wins. Non-memory behavior unchanged.
    appendDefaultSystemPrompt: args.noDefaultSystem ? false : !args.memory,
    compactionStrategy: args.compactStrategy,
  });

  // Slice 3-XR-Handoff (#50) — apply the previously parsed handoff blob now
  // that the agent exists. Read + parse happened above (pre-LLM-check) so
  // file-shape errors are visible without provider configured.
  if (importedHandoffBlob !== undefined) {
    const blob = importedHandoffBlob as { turnCount?: number; anchors?: unknown[] };
    await agent.importHandoff(importedHandoffBlob as never);
    if (args.debug) {
      process.stderr.write(
        `naia-agent: imported handoff blob from ${args.handoffIn} (${blob.turnCount ?? 0} turns, ${(blob.anchors ?? []).length} anchors)\n`,
      );
    }
  }

  // close the MemoryProvider on exit — agent.close() does not (cross-review
  // r1, gemini MAJOR). Harmless for InMemoryMemory, required for SQLite.
  try {
    const code = await executeAgent(agent, args);
    // Slice 3-XR-Handoff (#50) — `--handoff-out <path>` persists the session
    // recap at clean exit. Runs only on successful execution paths.
    if (args.handoffOut !== undefined && code === 0) {
      try {
        const blob = await agent.exportHandoff("session-close");
        await writeFile(args.handoffOut, JSON.stringify(blob, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        if (args.debug) {
          process.stderr.write(
            `naia-agent: handoff exported → ${args.handoffOut} (${blob.turnCount} turns, ${blob.anchors.length} anchors)\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `naia-agent: --handoff-out ${args.handoffOut} — write failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return code;
  } finally {
    await memory.close();
  }
}

/**
 * Runs an assembled Agent against the prompt source: positional arg / piped
 * stdin (single-shot) or an interactive TTY REPL. Shared by direct mode and
 * --service mode (R6/SB-1, #32) so manifest-built agents get the same UX.
 */
async function executeAgent(agent: Agent, args: Args): Promise<number> {
  // Single try/finally so agent.close() runs on every path including a
  // streamToStdout throw (cross-review r1, gemini MINOR — exception safety).
  try {
    if (args.prompt.length > 0) {
      // Single-shot mode (prompt from argv or non-TTY pipe)
      const ok = await safeTurn(agent, args.prompt, args.debug);
      return ok ? 0 : 2;
    }

    // REPL mode — requires TTY (or `--repl` force).
    if (!process.stdin.isTTY && !args.forceRepl) {
      // Read single prompt from stdin
      const piped = await readStdin();
      if (piped.trim().length === 0) {
        process.stderr.write("naia-agent: no prompt (stdin empty and no positional arg)\n");
        return 3;
      }
      const ok = await safeTurn(agent, piped.trim(), args.debug);
      return ok ? 0 : 2;
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
      if (trimmed === "/reset") {
        agent.clearHistory();
        process.stdout.write("  ✓ 대화 초기화됨\n");
        rl.prompt();
        continue;
      }
      if (trimmed === "/setup") {
        rl.pause();
        const providerEnvKeys = [
          "NAIA_MAIN_PROVIDER", "NAIA_MAIN_MODEL", "NAIA_ANYLLM_API_KEY", "NAIA_ANYLLM_BASE_URL",
          "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL",
          "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
          "GLM_API_KEY", "GLM_MODEL", "GLM_BASE_URL",
          "VERTEX_PROJECT_ID", "VERTEX_REGION",
        ];
        for (const k of providerEnvKeys) delete process.env[k];
        await runOnboarding();
        loadEnvAndConfig();
        const credKeys3 = await readCredentialKeys();
        for (const keyName of credKeys3) {
          if (process.env[keyName] === undefined) {
            const val = keychainGet(keyName);
            if (val) process.env[keyName] = val;
          }
        }
        const newLlm = await buildLLMClient(args.model);
        if (newLlm) {
          agent.replaceLlm(newLlm);
          process.stdout.write("  ✓ 설정 완료. 계속 대화하세요.\n");
        } else {
          process.stderr.write("  ✗ LLM 설정 실패. 다시 시도하세요.\n");
        }
        rl.resume();
        rl.prompt();
        continue;
      }
      if (trimmed === "/help") {
        process.stdout.write(
          "  /reset    — 대화 초기화\n" +
          "  /setup    — 프로바이더/모델 재설정\n" +
          "  /sessions — 저장된 세션 목록\n" +
          "  /resume   — 이전 세션 이어하기\n" +
          "  /help     — 이 도움말\n" +
          "  exit      — 종료\n",
        );
        rl.prompt();
        continue;
      }
      if (trimmed === "/sessions") {
        const sessionsDir = path.join(naiaSettingsDir(), "sessions");
        try {
          const entries = await readdir(sessionsDir);
          const sessionFiles = entries.filter((e) => e.endsWith(".json")).sort().reverse();
          if (sessionFiles.length === 0) {
            process.stdout.write("  (저장된 세션 없음)\n");
          } else {
            for (const f of sessionFiles.slice(0, 20)) {
              try {
                const raw = await readFile(path.join(sessionsDir, f), "utf8");
                const blob = JSON.parse(raw) as { turnCount?: number; anchors?: unknown[]; savedAt?: string };
                const id = f.replace(".json", "");
                const turns = blob.turnCount ?? "?";
                const when = blob.savedAt ? new Date(blob.savedAt).toLocaleString() : "?";
                process.stdout.write(`  ${id}  (${turns} turns, ${when})\n`);
              } catch {
                process.stdout.write(`  ${f}\n`);
              }
            }
          }
        } catch {
          process.stdout.write("  (저장된 세션 없음)\n");
        }
        rl.prompt();
        continue;
      }
      if (trimmed === "/resume") {
        rl.pause();
        const sessionsDir = path.join(naiaSettingsDir(), "sessions");
        try {
          const entries = await readdir(sessionsDir);
          const sessionFiles = entries.filter((e) => e.endsWith(".json")).sort().reverse();
          if (sessionFiles.length === 0) {
            process.stdout.write("  (저장된 세션 없음)\n");
          } else {
            process.stdout.write("  세션 선택:\n");
            for (let i = 0; i < Math.min(sessionFiles.length, 10); i++) {
              process.stdout.write(`  ${i + 1}. ${sessionFiles[i].replace(".json", "")}\n`);
            }
            const choice = await promptLine("번호 또는 세션 ID");
            if (choice !== null && choice.trim()) {
              const idx = parseInt(choice.trim(), 10);
              const file = !isNaN(idx) && idx >= 1 && idx <= sessionFiles.length
                ? sessionFiles[idx - 1]
                : `${choice.trim()}.json`;
              const filePath = path.join(sessionsDir, file);
              try {
                const raw = await readFile(filePath, "utf8");
                const blob = JSON.parse(raw);
                agent.clearHistory();
                await agent.importHandoff(blob);
                const turnCount = blob.turnCount ?? "?";
                process.stdout.write(`  ✓ 세션 복원 (${turnCount} turns)\n`);
              } catch (err) {
                process.stderr.write(`  ✗ 세션 복원 실패: ${err instanceof Error ? err.message : String(err)}\n`);
              }
            }
          }
        } catch {
          process.stdout.write("  (저장된 세션 없음)\n");
        }
        rl.resume();
        rl.prompt();
        continue;
      }
      await safeTurn(agent, trimmed, args.debug);
      rl.prompt();
    }

    rl.close();

    try {
      const blob = await agent.exportHandoff("session-save");
      const sessionsDir = path.join(naiaSettingsDir(), "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const sessionId = `sess-${Date.now().toString(36)}`;
      await writeFile(
        path.join(sessionsDir, `${sessionId}.json`),
        JSON.stringify({ ...blob, savedAt: new Date().toISOString() }, null, 2) + "\n",
        "utf8",
      );
    } catch { /* non-fatal */ }

    return 0;
  } finally {
    agent.close();
  }
}

// ─── Service mode (R6/SB-1 — #32, matrix §D50) ──────────────────────────────
// Manifest = naia-adk workspace data file (NOT a Part-A contract). The loader
// reads it and fills the existing HostContext. Schema SoT:
//   naia-adk/docs/service-manifest-schema.md (v0.1.0)
// Keys/secrets are NEVER read from the manifest — host env only (schema §4,
// 4-repo plan A.6: LLM key = shell stronghold).

/**
 * Builds an LLMClient from `manifest.llm`. The API key always comes from the
 * host env (never the manifest). Returns null + a written stderr reason on a
 * missing key / unknown backend / untrusted baseURL so the caller exits 3.
 */
async function buildLLMClientFromManifest(
  llm: ServiceManifest["llm"],
): Promise<LLMClient | null> {
  const env = process.env;
  switch (llm.backend) {
    case "openai-compatible": {
      if (!llm.baseURL) {
        process.stderr.write(
          `naia-agent: manifest llm.backend "openai-compatible" requires llm.baseURL\n`,
        );
        return null;
      }
      const trust = manifestBaseURLTrust(llm.baseURL, env);
      if (!trust.ok) {
        process.stderr.write(`naia-agent: ${trust.reason}\n`);
        return null;
      }
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      // Reached only for a trusted (loopback/private or operator-allowlisted)
      // host. Local vLLM servers commonly accept any/empty key; OPENAI_API_KEY
      // / NAIA_SERVICE_API_KEY from host env (never the manifest).
      const apiKey = env.OPENAI_API_KEY ?? env.NAIA_SERVICE_API_KEY ?? "";
      const provider = createOpenAICompatible({
        name: "manifest-openai-compat",
        apiKey,
        baseURL: llm.baseURL,
      });
      process.stderr.write(
        `naia-agent: provider=openai-compat model=${llm.model} baseURL=${llm.baseURL}\n`,
      );
      return new VercelClient(provider.chatModel(llm.model));
    }
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        process.stderr.write(
          `naia-agent: manifest llm.backend "anthropic" needs ANTHROPIC_API_KEY in host env (never in manifest, schema §4)\n`,
        );
        return null;
      }
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        ...(env.ANTHROPIC_BASE_URL && { baseURL: env.ANTHROPIC_BASE_URL }),
      });
      process.stderr.write(`naia-agent: provider=anthropic model=${llm.model}\n`);
      return new VercelClient(anthropic(llm.model));
    }
    case "vertex": {
      if (!env.VERTEX_PROJECT_ID || !env.VERTEX_REGION) {
        process.stderr.write(
          `naia-agent: manifest llm.backend "vertex" needs VERTEX_PROJECT_ID + VERTEX_REGION in host env\n`,
        );
        return null;
      }
      const { createVertex } = await import("@ai-sdk/google");
      const vertex = createVertex({
        project: env.VERTEX_PROJECT_ID,
        location: env.VERTEX_REGION,
      });
      process.stderr.write(`naia-agent: provider=vertex model=${llm.model}\n`);
      return new VercelClient(vertex(llm.model));
    }
    case "claude-code": {
      // Claude Agent SDK in-process via ai-sdk-provider-claude-code (D18,
      // adopted; same pattern as runtime coding-tool.ts). Uses the user's
      // Claude subscription auth — NO API key (subscription Agent SDK credit,
      // policy 2026-06-15; per-account, capped). Dynamic import keeps the SDK
      // optional at module load. Refs naia-agent#39 (two-tier main-llm).
      const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
      const provider = createClaudeCode();
      process.stderr.write(
        `naia-agent: provider=claude-code model=${llm.model} (subscription, no API key)\n`,
      );
      return new VercelClient(provider(llm.model as Parameters<typeof provider>[0]));
    }
    case "langgraph":
    case "rag-retriever": {
      // Reserve stub (Slice 3-XR-J piggyback for #23). These backends are
      // recognized as valid manifest values so authors can declare intent
      // ahead of implementation. The actual dispatcher (LangGraph node
      // routing / RAG retriever + vector store + LLM hop) is deferred —
      // see Slice 3-XR-K. Until then, refuse cleanly with a stable
      // exit + a self-explaining stderr line. cf
      //   .agents/progress/slice-3-xr-h-i-j-l-plan-2026-05-20.md §3
      //   feedback_pi_substrate_not_glm_only_2026_05_20
      process.stderr.write(
        `naia-agent: manifest llm.backend "${llm.backend}" not implemented yet (deferred to Slice 3-XR-K). ` +
          `Reserve stub: schema accepts the value but no live dispatcher is wired.\n`,
      );
      return null;
    }
    default:
      process.stderr.write(
        `naia-agent: unknown manifest llm.backend "${llm.backend}" ` +
          `(supported: openai-compatible | anthropic | vertex | claude-code; ` +
          `reserved: langgraph | rag-retriever)\n`,
      );
      return null;
  }
}

/**
 * "alpha-memory" binding factory. naia-memory is imported lazily (heavy
 * footprint) so the in-memory path and the schema validator never load it.
 * Mirrors examples/hardened-sqlite-host.ts (SqliteAdapter + MemorySystem +
 * OfflineEmbeddingProvider). DB path: env NAIA_AGENT_MEMORY_DB override, else
 * ~/.naia-agent/services/<name>.db (host policy — not a manifest field).
 */
async function buildAlphaMemory(serviceName: string): Promise<MemoryProvider> {
  // Cross-repo source-relative specifier — INTENTIONAL, matches the canonical
  // alpha-memory integration example examples/hardened-sqlite-host.ts (same
  // `projects/naia-agent/*` depth → resolves to `projects/naia-memory`). The
  // bin runs via tsx (shebang `pnpm exec tsx`); `@nextain/naia-memory`'s
  // package export points at `./dist` which would force a naia-memory build
  // and break the no-build source-run flow. Switching to the package
  // specifier is deferred to the standalone-published CLI host (Phase 2,
  // README Status). Cross-review r1 (gemini): verified resolves at runtime.
  const { SqliteAdapter, MemorySystem, OfflineEmbeddingProvider } = await import(
    "../../naia-memory/src/memory/index.js"
  );
  // `serviceName` is already restricted to strict kebab by
  // parseServiceManifest (no separators / ".."). Defense-in-depth: for the
  // default (name-derived) path, assert the resolved DB stays inside the
  // services dir before touching the filesystem (security review SB-1
  // Vuln 2). The env override is operator-trusted and not constrained.
  let dbPath: string;
  if (process.env.NAIA_AGENT_MEMORY_DB) {
    dbPath = process.env.NAIA_AGENT_MEMORY_DB;
  } else {
    const servicesDir = path.join(homedir(), ".naia-agent", "services");
    dbPath = path.resolve(servicesDir, `${serviceName}.db`);
    if (dbPath !== path.join(servicesDir, `${serviceName}.db`) ||
        !dbPath.startsWith(servicesDir + path.sep)) {
      throw new Error(`refusing alpha-memory db path outside ${servicesDir} (name="${serviceName}")`);
    }
  }
  const adapter = new SqliteAdapter({
    dbPath,
    embeddingProvider: new OfflineEmbeddingProvider(),
  });
  const sys = new MemorySystem({ adapter });
  await sys.init();
  process.stderr.write(`naia-agent: memory=alpha-memory db=${dbPath}\n`);

  // Minimal MemoryProvider façade (SB-1 needs only the core contract:
  // encode / recall / consolidate / close). Capabilities are out of scope.
  return {
    async encode(input) {
      await sys.encode(
        { content: input.content, role: input.role, timestamp: input.timestamp },
        { sessionId: input.context?.["sessionId"], project: input.context?.["project"] },
      );
    },
    async recall(query, opts) {
      const topK = opts?.topK ?? 5;
      const result = await sys.recall(query, {
        topK,
        deepRecall: opts?.deepRecall,
        project: opts?.project,
      });
      const hits = [
        ...result.facts.map((f: { id: string; content: string; relevanceScore?: number; createdAt?: number }) => ({
          id: f.id,
          content: f.content,
          score: f.relevanceScore ?? 0,
          createdAt: f.createdAt,
          metadata: { type: "fact" },
        })),
        ...result.episodes.map((e: { id: string; content: string; strength?: number; timestamp?: number }) => ({
          id: e.id,
          content: e.content,
          score: e.strength ?? 0.5,
          createdAt: e.timestamp,
          metadata: { type: "episode" },
        })),
      ];
      return hits.sort((a, b) => b.score - a.score).slice(0, topK);
    },
    async consolidate() {
      const t0 = performance.now();
      const r = await sys.consolidateNow(true);
      return {
        factsCreated: r.factsCreated,
        factsUpdated: r.factsUpdated,
        episodesProcessed: r.episodesProcessed,
        durationMs: performance.now() - t0,
      };
    },
    async close() {
      await sys.close();
    },
  };
}

async function runService(args: Args): Promise<number> {
  const manifestPath = args.service as string;

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (e) {
    // File I/O failure surfaces as the SAME canonical MANIFEST_INVALID
    // ErrorEvent the parser emits (design §5, Part A.11) — reuse the shared
    // builder so the shape never drifts (cross-review r4, codex MEDIUM).
    const err = manifestInvalid(
      `cannot read manifest "${manifestPath}": ${(e as Error).message}`,
    );
    process.stderr.write(JSON.stringify(err) + "\n");
    return 3;
  }

  const result = parseServiceManifest(raw);
  if (!result.ok) {
    // Surface the manifest PATH alongside the structured error so a user
    // with several manifests knows which one parsed wrong (cross-review
    // A-F8). Keep the canonical JSON line for machine consumers.
    process.stderr.write(`naia-agent: invalid manifest "${manifestPath}"\n`);
    process.stderr.write(JSON.stringify(result.error) + "\n");
    return 3;
  }
  const manifest = result.manifest;

  const llm = await buildLLMClientFromManifest(manifest.llm);
  if (!llm) return 3;

  // Test-only hermetic routing gate (naia-agent#39 G1). When set, the LLM
  // client has been built (provider routing succeeded) — exit cleanly
  // WITHOUT memory/agent assembly or any LLM call (no credit). Never set in
  // production. A broken provider branch → buildLLMClientFromManifest null
  // → exits 3 above → the gate test fails. Keeps the builder in the
  // composition root (no cross-package extraction).
  if (process.env.NAIA_AGENT_DRYRUN === "1") {
    process.stderr.write(
      `naia-agent: dry-run OK — llm client built (backend=${manifest.llm.backend})\n`,
    );
    return 0;
  }

  let memory: MemoryProvider;
  try {
    memory = await resolveMemoryBinding(manifest.memory.binding, {
      alphaMemoryFactory: () => buildAlphaMemory(manifest.name),
    });
  } catch (e) {
    process.stderr.write(`naia-agent: ${(e as Error).message}\n`);
    return 3;
  }

  const logger = new ConsoleLogger({ level: args.debug ? "debug" : "warn" });
  const host: HostContext = {
    llm,
    memory,
    tools: ((): ToolExecutor => {
      const inMem = new InMemoryToolExecutor(
        args.noTools
          ? []
          : [
              createBashSkill(),
              createTimeSkill(),
              createWeatherSkill(),
              createSystemStatusSkill(),
              createMemoSkill(),
              createDiagnosticsSkill({ sessionManager, configManager, startedAt: PROCESS_STARTED_AT }),
              createSessionsSkill({ sessionManager }),
              createConfigSkill({ configManager }),
              ...(args.enableFileOps ? createFileOpsSkills({ workspaceRoot: args.workdir }) : []),
            ],
      );
      if (!args.skillsDir) return inMem;
      return new CompositeToolExecutor({
        subs: [
          { id: "builtins", executor: inMem },
          {
            id: "naia-adk-skills",
            executor: new SkillToolExecutor({
              loader: new FileSkillLoader({
                workspaceRoot: args.skillsDir,
                skillsDir: args.skillsDir,
                onWarn: (m) => process.stderr.write(`naia-agent: skills-dir warn: ${m}\n`),
              }),
            }),
          },
        ],
      });
    })(),
    logger,
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
    approvals: {
      async decide() {
        throw new Error("naia-agent: tool approval not wired (service mode)");
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

  process.stderr.write(`naia-agent: service="${manifest.name}" (schema ${manifest.schemaVersion})\n`);
  const agent = new Agent({
    host,
    systemPrompt: manifest.persona.systemPrompt,
    tierForTool: () => "T1",
    compactionStrategy: args.compactStrategy,
  });

  // close the MemoryProvider on exit — agent.close() does not (cross-review
  // r1, gemini MAJOR). For "alpha-memory" this checkpoints/closes the SQLite
  // connection (WAL) instead of leaking it on CLI exit.
  try {
    return await executeAgent(agent, args);
  } finally {
    await memory.close();
  }
}

async function streamToStdout(agent: Agent, prompt: string, debug: boolean): Promise<void> {
  for await (const ev of agent.sendStream(prompt)) {
    if (ev.type === "turn.ended") {
      // Print the agent's FINAL sanitized answer (not raw streamed
      // tokens) — raw streaming bypassed stripRecallResidue, leaking
      // small-model malformed `<recal…>` markers. assistantText is
      // already stripped at agent.ts; re-strip is idempotent insurance
      // for the user-facing surface. (Trade-off: no live token stream;
      // acceptable for short memory-CLI answers.)
      process.stdout.write(`${stripRecallResidue(ev.assistantText)}\n`);
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

/**
 * Run one turn without ever crashing the process. A model-server outage
 * (ECONNREFUSED etc.) must NOT kill the REPL or fatal-exit single-shot —
 * it prints a clean, actionable message and the caller decides flow.
 */
async function safeTurn(agent: Agent, prompt: string, debug: boolean): Promise<boolean> {
  try {
    await streamToStdout(agent, prompt, debug);
    return true;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const conn = /ECONNREFUSED|Cannot connect|fetch failed|ENOTFOUND|ETIMEDOUT|socket hang up|network|getaddrinfo/i.test(msg);
    const noTools = /does not support tools|tool[_ ]?call|function[_ ]?call|tools.*unsupported/i.test(msg);
    const url =
      process.env["OPENAI_BASE_URL"] ?? process.env["ANTHROPIC_BASE_URL"] ?? process.env["GLM_BASE_URL"];
    process.stderr.write(
      `\nnaia-agent: turn failed — ${msg}\n` +
        (conn
          ? `  The model server${url ? ` at ${url}` : ""} is unreachable. Start it, or reconfigure:\n` +
            `    pnpm naia-agent login --adk <naia-adk> \\\n` +
            `      --main "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"\n`
          : noTools
          ? `  This model has no native tool-calling. Exit (\`exit\`/Ctrl-D) and re-run with --no-tools:\n` +
            `    pnpm naia-agent --no-tools                          # REPL\n` +
            `    pnpm naia-agent --no-tools --memory "your prompt"   # one-shot, with memory\n`
          : ""),
    );
    return false;
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

// ─── Stdio IPC mode (--stdio) ─────────────────────────────────────────────────
// Implements the JSON-line IPC protocol used by naia-os shell to communicate with
// its embedded agent core. Allows the standalone naia-agent binary to be spawned
// by naia-os as an alternative to the embedded agent.
//
// Stdin (newline-delimited JSON):
//   { type: "auth_update",    naiaKey }        → set NAIA_ANYLLM_API_KEY
//   { type: "notify_config",  ... }            → set webhook env vars
//   { type: "creds_update",   keys, ttsKeys }  → set provider API keys
//   { type: "skill_inject",   tools }           → register host proxy stubs
//   { type: "skill_revoke",   names }           → unregister host proxy stubs
//   { type: "chat_request",   requestId, messages, systemPrompt } → run chat
//   { type: "cancel_stream",  requestId }      → abort in-flight request
//   { type: "panel_tool_result", requestId, toolCallId, result, success } → proxy result
//
// Stdout (newline-delimited JSON):
//   { type: "text",              requestId, text }    → incremental text chunk
//   { type: "finish",            requestId }          → request completed
//   { type: "error",             requestId, message } → request failed
//   { type: "panel_tool_call",   requestId, toolCallId, toolName, args } → proxy call
//
// Phase 2 note: each chat_request uses only the last user message as the prompt.
// Full multi-turn history forwarding is deferred to Phase 3.

function stdioWriteLine(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

async function runStdio(): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const activeStreams = new Map<string, AbortController>();
  const pendingToolCalls = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  const TOOL_TIMEOUT_MS = 30_000;

  const hostInjectedDefs: ToolDefinitionWithTier[] = [];
  let cachedLlm: LLMClient | null | undefined = undefined;
  let cachedMemory: InMemoryMemory | null = null;
  let hostToolExecutor: ToolExecutor = {
    list: async () => hostInjectedDefs,
    execute: async (inv) => {
      const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestId = "proxy";
      stdioWriteLine({ type: "panel_tool_call", requestId, toolCallId, toolName: inv.name, args: inv.input });
      return new Promise<ToolExecutionResult>((resolve, reject) => {
        const tid = setTimeout(() => reject(new Error(`Host tool timed out: ${inv.name}`)), TOOL_TIMEOUT_MS);
        pendingToolCalls.set(toolCallId, {
          resolve: (v) => { clearTimeout(tid); resolve({ content: v }); },
          reject: (e) => { clearTimeout(tid); resolve({ content: e.message, isError: true }); },
        });
      });
    },
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof msg.type === "string" ? msg.type : null;
    if (!type) continue;

    switch (type) {
      case "auth_update": {
        const key = typeof msg.naiaKey === "string" ? msg.naiaKey : "";
        if (key) process.env["NAIA_ANYLLM_API_KEY"] = key;
        else delete process.env["NAIA_ANYLLM_API_KEY"];
        cachedLlm = undefined;
        break;
      }
      case "notify_config": {
        const pairs: [string, unknown][] = [
          ["SLACK_WEBHOOK_URL", msg.slackWebhookUrl],
          ["DISCORD_WEBHOOK_URL", msg.discordWebhookUrl],
          ["GOOGLE_CHAT_WEBHOOK_URL", msg.googleChatWebhookUrl],
          ["DISCORD_DEFAULT_USER_ID", msg.discordDefaultUserId],
          ["DISCORD_DEFAULT_TARGET", msg.discordDefaultTarget],
          ["DISCORD_DEFAULT_CHANNEL_ID", msg.discordDmChannelId],
        ];
        for (const [envKey, val] of pairs) {
          if (typeof val !== "string") continue;
          const v = val.trim();
          if (v) process.env[envKey] = v;
          else delete process.env[envKey];
        }
        break;
      }
      case "creds_update": {
        const keys =
          msg.keys && typeof msg.keys === "object" && !Array.isArray(msg.keys)
            ? (msg.keys as Record<string, string>)
            : {};
        // Map well-known provider IDs → env vars (mirrors all buildLLMClient() branches).
        // Base URL / model vars (NAIA_ANYLLM_BASE_URL, OPENAI_BASE_URL, NAIA_MAIN_MODEL)
        // are configuration rather than secrets and are expected to arrive via
        // naia-settings/config.json loaded by loadEnvAndConfig() at startup.
        const keyMap: Record<string, string> = {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          "naia-anyllm": "NAIA_ANYLLM_API_KEY",
          glm: "GLM_API_KEY",
          vertex: "VERTEX_PROJECT_ID",
          "vertex-region": "VERTEX_REGION",
          "embedding-api-key": "NAIA_EMBED_API_KEY",
          "memory-llm-api-key": "NAIA_LLM_API_KEY",
        };
        for (const [id, apiKey] of Object.entries(keys)) {
          const envKey = keyMap[id];
          if (!envKey) continue;
          if (apiKey) process.env[envKey] = apiKey;
          else delete process.env[envKey];
        }
        cachedLlm = undefined;
        break;
      }
      case "chat_request": {
        const requestId =
          typeof msg.requestId === "string" ? msg.requestId : `req-${Date.now()}`;
        const messages = Array.isArray(msg.messages)
          ? (msg.messages as Array<{ role: string; content: unknown }>)
          : [];
        const sysPrompt =
          typeof msg.systemPrompt === "string" ? msg.systemPrompt : undefined;

        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        if (!lastUser) {
          stdioWriteLine({ type: "error", requestId, message: "no user message in request" });
          break;
        }
        // [fix] coerce content to string to guard against non-string values from the host
        const prompt = typeof lastUser.content === "string"
          ? lastUser.content
          : String(lastUser.content ?? "");

        const controller = new AbortController();
        activeStreams.set(requestId, controller);

        // Fire-and-forget so cancel_stream can arrive on the readline while streaming.
        void (async () => {
          if (cachedLlm === undefined) {
            cachedLlm = await buildLLMClient();
          }
          const llm = cachedLlm;
          if (!llm) {
            stdioWriteLine({ type: "error", requestId, message: "no LLM provider configured" });
            activeStreams.delete(requestId);
            return;
          }

          const baseTools = new InMemoryToolExecutor([
            createBashSkill(),
            createTimeSkill(),
            createWeatherSkill(),
            createSystemStatusSkill(),
            createMemoSkill(),
            createDiagnosticsSkill({ sessionManager, configManager, startedAt: PROCESS_STARTED_AT }),
            createSessionsSkill({ sessionManager }),
            createConfigSkill({ configManager }),
          ]);
          const tools: ToolExecutor = hostInjectedDefs.length > 0
            ? new CompositeToolExecutor({ subs: [{ id: "builtins", executor: baseTools }, { id: "host", executor: hostToolExecutor }] })
            : baseTools;
          if (!cachedMemory) cachedMemory = new InMemoryMemory();
          const memory = cachedMemory;
          const host: HostContext = {
            llm,
            memory,
            tools,
            tracer: new NoopTracer(),
            meter: new InMemoryMeter(),
            approvals: {
              async decide() {
                return { status: "approved" as const, at: Date.now() };
              },
            },
            identity: {
              deviceId: "naia-agent-standalone",
              publicKeyEd25519: "standalone",
              async sign() {
                throw new Error("sign() not wired");
              },
            },
          };

          const agent = new Agent({ host, systemPrompt: sysPrompt, tierForTool: () => "T1" });

          try {
            for await (const ev of agent.sendStream(prompt)) {
              if (controller.signal.aborted) break;
              if (ev.type === "llm.chunk") {
                if (
                  ev.chunk.type === "content_block_delta" &&
                  ev.chunk.delta.type === "text_delta"
                ) {
                  stdioWriteLine({ type: "text", requestId, text: ev.chunk.delta.text });
                }
              }
            }
            if (!controller.signal.aborted) {
              stdioWriteLine({ type: "finish", requestId });
            }
          } catch (err) {
            stdioWriteLine({
              type: "error",
              requestId,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            agent.close();
            activeStreams.delete(requestId);
          }
        })();
        break;
      }
      case "cancel_stream": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        const ctrl = activeStreams.get(requestId);
        if (ctrl) {
          ctrl.abort();
          activeStreams.delete(requestId);
        }
        break;
      }
      case "skill_inject": {
        const tools = Array.isArray(msg.tools) ? msg.tools as Array<Record<string, unknown>> : [];
        for (const t of tools) {
          const name = typeof t.name === "string" ? t.name : "";
          if (!name) continue;
          const idx = hostInjectedDefs.findIndex((d) => d.name === name);
          const def: ToolDefinitionWithTier = {
            name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: (t.parameters ?? t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
            tier: (typeof t.tier === "string" ? t.tier : typeof t.tier === "number" ? `T${t.tier}` : "T1") as ToolDefinitionWithTier["tier"],
          };
          if (idx >= 0) hostInjectedDefs[idx] = def;
          else hostInjectedDefs.push(def);
        }
        break;
      }
      case "skill_revoke": {
        const names = Array.isArray(msg.names) ? msg.names as string[] : [];
        for (const n of names) {
          const idx = hostInjectedDefs.findIndex((d) => d.name === n);
          if (idx >= 0) hostInjectedDefs.splice(idx, 1);
        }
        break;
      }
      case "panel_tool_result": {
        const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
        const pending = pendingToolCalls.get(toolCallId);
        if (!pending) break;
        pendingToolCalls.delete(toolCallId);
        const success = msg.success !== false;
        const result = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result ?? "");
        if (success) pending.resolve(result);
        else pending.reject(new Error(result));
        break;
      }
      case "tts_request": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : `tts-${Date.now()}`;
        stdioWriteLine({ type: "tts_ack", requestId, status: "not_supported" });
        break;
      }
      case "tool_request": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : `tool-${Date.now()}`;
        stdioWriteLine({ type: "tool_ack", requestId, status: "not_supported" });
        break;
      }
      case "skill_list": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : `skill-${Date.now()}`;
        const names = hostInjectedDefs.map((d) => d.name);
        stdioWriteLine({ type: "skill_list_response", requestId, skills: names });
        break;
      }
      case "approval_response": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        stdioWriteLine({ type: "approval_ack", requestId, status: "accepted" });
        break;
      }
    }
  }

  // [fix] stdin closed: abort all in-flight streams so fire-and-forget IIFEs
  // can reach their finally blocks before process.exit() runs.
  for (const ctrl of activeStreams.values()) {
    ctrl.abort();
  }
  activeStreams.clear();

  return 0;
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
  if (a.adapter === "pi") {
    return new PiRunAdapter({
      ...(a.model !== undefined && { model: a.model }),
    });
  }
  return new OpencodeRunAdapter({
    ...(a.model !== undefined && { model: a.model }),
    skipPermissions: !a.acp,
  });
}

function buildSupervisorApprovalBroker(a: Args): ApprovalBroker | undefined {
  if (a.adapter === "shell" || a.adapter === "opencode-cli" || a.adapter === "pi") return undefined;
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

// ─── Login subcommand ─────────────────────────────────────────────────────────
// Saves provider API key(s) to ~/.naia-agent/.env (appends; never overwrites).
// Usage: pnpm naia-agent login --key <provider>
// Ref design: opencode auth.json (per-provider), pi OAuth PKCE (deferred).

const LOGIN_PROVIDERS: Record<string, { envKey: string; label: string; secret?: boolean; optional?: boolean }[]> = {
  "claude-code": [],
  anthropic: [
    { envKey: "ANTHROPIC_API_KEY", label: "Anthropic API key (sk-ant-...)", secret: true },
  ],
  openai: [
    { envKey: "OPENAI_API_KEY",  label: "OpenAI API key", secret: true },
    { envKey: "OPENAI_BASE_URL", label: "OpenAI base URL (e.g. https://api.openai.com/v1)" },
  ],
  glm: [
    { envKey: "GLM_API_KEY", label: "zai coding plan API key", secret: true },
  ],
  vllm: [
    { envKey: "OPENAI_API_KEY",  label: "vLLM API key (Enter to skip)", secret: true, optional: true },
    { envKey: "OPENAI_BASE_URL", label: "vLLM base URL (e.g. http://localhost:8000/v1)" },
  ],
  ollama: [
    { envKey: "OPENAI_BASE_URL", label: "Ollama base URL", optional: true },
  ],
};

/**
 * Raw-mode line prompt. Enter = confirm, ESC/Ctrl+C = go back (returns null).
 * Paste-safe: handles multi-char chunks (clipboard paste sends all chars at once).
 * When secret=true input is masked with '*' (count matches actual chars typed/pasted).
 */
function promptLine(label: string, secret = false): Promise<string | null> {
  return new Promise((res) => {
    process.stdout.write(`${label} (ESC to go back): `);
    let buf = "";

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const finish = (value: string | null) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (value !== null) {
        process.stdout.write(`\n  -> ${value.length} chars entered\n`);
      } else {
        process.stdout.write("\n");
      }
      res(value);
    };

    const onData = (chunk: string) => {
      // ESC alone or Ctrl+C → go back
      if (chunk === "\u001b" || chunk === "\u0003") {
        finish(null);
        return;
      }
      // ESC sequences (arrow keys, fn keys) — swallow entire chunk so terminal
      // escape bytes don't leak into the input buffer as printable characters.
      if (chunk.startsWith("\u001b")) {
        return;
      }
      // Enter
      if (chunk === "\r" || chunk === "\n") {
        if (buf.trim().length === 0) {
          process.stdout.write("  (type a value, ESC to go back)\r\x1b[A\x1b[2K");
          process.stdout.write(`${label} (ESC to go back): `);
        } else {
          finish(buf.trim());
        }
        return;
      }
      // Backspace — handle one at a time
      if (chunk === "\u007f" || chunk === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          if (secret) {
            process.stdout.write("\b \b");
          } else {
            process.stdout.write("\b \b");
          }
        }
        return;
      }
      // Printable chars — paste sends multiple chars at once
      // Filter out any embedded control chars (ESC sequences from terminal)
      const printable = [...chunk].filter((c) => c.charCodeAt(0) >= 32).join("");
      if (printable.length > 0) {
        buf += printable;
        process.stdout.write(secret ? "*".repeat(printable.length) : printable);
      }
    };

    process.stdin.on("data", onData);
  });
}

// ─── OS Keychain ──────────────────────────────────────────────────────────────
// Keys are stored in the OS credential store (never written to disk as plaintext).
// credentials file = manifest of key *names* only (no values).

const KEYCHAIN_SERVICE = "naia-agent";

/**
 * Secure key storage per platform:
 *   Windows — DPAPI encrypted file in naia-settings/.keys/ (per-user OS encryption)
 *   macOS   — Keychain (security CLI)
 *   Linux   — Secret Service (secret-tool)
 */
function keysDir(): string {
  return path.join(naiaSettingsDir(), ".keys");
}

/** Store a secret. Returns true on success. */
function keychainSet(keyName: string, value: string): boolean {
  try {
    if (process.platform === "win32") {
      // DPAPI: encrypt with current-user scope, store as .dpapi binary file
      const outFile = path.join(keysDir(), `${keyName}.dpapi`).replace(/\\/g, "\\\\");
      const script = [
        `Add-Type -AssemblyName System.Security`,
        `$v = [Console]::In.ReadLine()`,
        `$b = [System.Text.Encoding]::UTF8.GetBytes($v)`,
        `$enc = [System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')`,
        `$null = [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName('${outFile}'))`,
        `[System.IO.File]::WriteAllBytes('${outFile}',$enc)`,
      ].join(";");
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        input: value, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"],
      });
      return r.status === 0;
    } else if (process.platform === "darwin") {
      const r = spawnSync("security", [
        "add-generic-password", "-U", "-a", keyName, "-s", KEYCHAIN_SERVICE, "-w", value,
      ], { stdio: "ignore" });
      return r.status === 0;
    } else {
      const r = spawnSync("secret-tool", [
        "store", "--label", `${KEYCHAIN_SERVICE}:${keyName}`,
        "service", KEYCHAIN_SERVICE, "username", keyName,
      ], { input: value, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
      return r.status === 0;
    }
  } catch {
    return false;
  }
}

/** Retrieve a secret. Returns null if not found or decryption fails. */
function keychainGet(keyName: string): string | null {
  try {
    if (process.platform === "win32") {
      const keyFile = path.join(keysDir(), `${keyName}.dpapi`).replace(/\\/g, "\\\\");
      const script = [
        `Add-Type -AssemblyName System.Security`,
        `$enc = [System.IO.File]::ReadAllBytes('${keyFile}')`,
        `$b = [System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,'CurrentUser')`,
        `Write-Output ([System.Text.Encoding]::UTF8.GetString($b))`,
      ].join(";");
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      return r.stdout?.trim() || null;
    } else if (process.platform === "darwin") {
      const r = spawnSync("security", [
        "find-generic-password", "-a", keyName, "-s", KEYCHAIN_SERVICE, "-w",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return r.stdout?.trim() || null;
    } else {
      const r = spawnSync("secret-tool", [
        "lookup", "service", KEYCHAIN_SERVICE, "username", keyName,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return r.stdout?.trim() || null;
    }
  } catch {
    return null;
  }
}

/** naia-settings directory path. */
function resolveAdkPath(): string {
  if (process.env["NAIA_ADK_PATH"]) return process.env["NAIA_ADK_PATH"];

  const bootstrapPath = path.join(homedir(), ".naia-agent", "config.json");
  try {
    const raw = readFileSync(bootstrapPath, "utf8");
    const cfg = JSON.parse(raw) as { adkPath?: string; naiaAdkPath?: string };
    const resolved = cfg.adkPath || cfg.naiaAdkPath;
    if (resolved && typeof resolved === "string") return resolved;
  } catch { /* not found or invalid */ }

  const cachePath = path.join(homedir(), ".naia", "adk-path");
  try {
    const cached = readFileSync(cachePath, "utf8").trim();
    if (cached) return cached;
  } catch { /* not found */ }

  return path.join(homedir(), "naia-adk");
}

function naiaSettingsDir(): string {
  return path.join(resolveAdkPath(), "naia-settings");
}

/** credentials manifest: list of key names stored in OS keychain. */
async function readCredentialKeys(): Promise<string[]> {
  try {
    const raw = await readFile(path.join(naiaSettingsDir(), "credentials"), "utf8");
    const parsed = JSON.parse(raw) as { keys?: string[] };
    return Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch { return []; }
}

async function addCredentialKey(keyName: string): Promise<void> {
  const dir = naiaSettingsDir();
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, "credentials");
  const keys = await readCredentialKeys();
  if (!keys.includes(keyName)) {
    keys.push(keyName);
    await writeFile(p, JSON.stringify({ keys }, null, 2) + "\n", "utf8");
  }
}

// ─── Login helpers ────────────────────────────────────────────────────────────

/**
 * Load naia model list from naia-os registry (SoT).
 * Dynamic import so the naia-os source tree is the single source of truth.
 * Returns static fallback if the import fails (e.g. naia-os not present).
 */
async function getNaiaRegistryMeta(): Promise<{ defaultModel: string; modelIds: string[] }> {
  try {
    const { getProvider } = await import("../packages/providers/src/registry.js");
    const p = getProvider("nextain");
    if (p) {
      const pricingModels = await fetchPricingOverlay();
      const models = pricingModels ?? p.models;
      const ids = models.map((m) => m.id);
      const defaultIdx = ids.indexOf(p.defaultModel);
      if (defaultIdx > 0) {
        const [removed] = ids.splice(defaultIdx, 1);
        ids.unshift(removed);
      }
      return { defaultModel: p.defaultModel || "gemini-3.5-flash", modelIds: ids };
    }
  } catch { /* fallback below */ }
  return {
    defaultModel: "gemini-3.5-flash",
    modelIds: [
      "gemini-3.5-flash",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-live",
      "naia-omni-24g",
      "naia-omni-32g",
    ],
  };
}

async function fetchPricingOverlay() {
  try {
    const { fetchNaiaPricing } = await import("../packages/providers/src/registry.js");
    return await fetchNaiaPricing();
  } catch { return null; }
}

const DEFAULT_GATEWAY_HTTP_URL_CLI =
  process.env["NAIA_GATEWAY_URL"] ||
  "https://naia-gateway-181404717065.asia-northeast3.run.app";

const PROVIDER_DEFAULTS: Record<string, string> = {
  "claude-code": "sonnet",
  anthropic: "claude-opus-4-5",
  openai: "gpt-4o",
  glm: "glm-4.5-flash",
  vllm: "Qwen/Qwen3-8B",
  ollama: "llama3.2",
};

const CLAUDE_CODE_MODELS = [
  "sonnet   (claude-sonnet-4 — fast & balanced)",
  "opus     (claude-opus-4 — most capable)",
  "haiku    (claude-haiku-4 — fastest)",
];

const EMBED_DEFAULTS: Record<string, string> = {
  naia: "google/text-embedding-004",
  openai: "text-embedding-3-small",
  anthropic: "voyage-3",
  vllm: "BAAI/bge-m3",
  ollama: "nomic-embed-text",
};

// Agents bundled with naia-agent (no separate download needed)
const AGENT_TYPES = ["pi", "opencode", "claude-code", "codex", "gemini"] as const;
// Display labels (shown in UI; pi uses npx auto-install)
const AGENT_DISPLAYS: readonly string[] = [
  "pi           (naia — auto-installed via npx on first use)",
  "opencode",
  "claude-code",
  "codex",
  "gemini",
];

// ── TTY menu render helpers ───────────────────────────────────────────────────
// Uses ANSI cursor save/restore (\x1b[s / \x1b[u) to redraw in-place.
// Each line is overwritten with \x1b[2K (erase line) before new content.

function menuLine(content: string): void {
  process.stdout.write(`\x1b[2K${content}\n`);
}

/** Generic arrow-key selection menu (TTY only). Returns selected item or null if aborted. */
async function selectFromList(prompt: string, items: readonly string[]): Promise<string | null> {
  let idx = 0;
  const render = (isInitial: boolean) => {
    if (!isInitial) process.stdout.write("\x1b[u"); // restore saved cursor pos
    menuLine(`${prompt} (↑↓ Enter)`);
    for (let i = 0; i < items.length; i++) {
      menuLine(`  ${i === idx ? "❯" : " "} ${items[i]}`);
    }
  };
  process.stdout.write("\x1b[s"); // save cursor before first draw
  render(true);
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key: string) => {
      if (key === "\r" || key === "\n") { cleanup(); resolve(items[idx]!); return; }
      if (key === "\u001b[A") { idx = (idx - 1 + items.length) % items.length; render(false); return; }
      if (key === "\u001b[B") { idx = (idx + 1) % items.length; render(false); return; }
      // Swallow other multi-byte ESC sequences (fn keys, delete, etc.) before the bare-ESC check
      // so they don't accidentally close the menu. Bare ESC (\u001b, 1 char) still closes.
      if (key.startsWith("\u001b") && key.length > 1) { return; }
      if (key === "\u001b" || key === "\u0003") { cleanup(); resolve(null); return; }
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

/** Menu with optional right-side hints. Returns selected index or null if aborted (Ctrl+C). */
async function selectFromMenu(
  prompt: string,
  items: readonly { label: string; hint?: string }[],
): Promise<number | null> {
  let idx = 0;
  const PAD = 42;
  const render = (isInitial: boolean) => {
    if (!isInitial) process.stdout.write("\x1b[u");
    menuLine(`${prompt} (↑↓ Enter)`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const hint = item.hint ? `\x1b[2m  ${item.hint}\x1b[0m` : "";
      menuLine(`  ${i === idx ? "❯" : " "} ${item.label.padEnd(PAD)}${hint}`);
    }
  };
  process.stdout.write("\x1b[s");
  render(true);
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key: string) => {
      if (key === "\r" || key === "\n") { cleanup(); resolve(idx); return; }
      if (key === "\u001b[A") { idx = (idx - 1 + items.length) % items.length; render(false); return; }
      if (key === "\u001b[B") { idx = (idx + 1) % items.length; render(false); return; }
      if (key.startsWith("\u001b") && key.length > 1) { return; }
      if (key === "\u001b" || key === "\u0003") { cleanup(); resolve(null); return; }
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

/**
 * Checkbox-style multi-select menu (↑↓ moves, Space toggles, Enter confirms).
 * `initial` = values already checked. Returns selected values or null if Ctrl+C.
 */
async function selectMultiple(
  prompt: string,
  items: readonly string[],
  displays: readonly string[],
  initial: readonly string[],
): Promise<string[] | null> {
  let cursor = 0;
  const checked = new Set<string>(initial);
  const render = (isInitial: boolean) => {
    if (!isInitial) process.stdout.write("\x1b[u");
    menuLine(`${prompt} (↑↓ Space select  Enter confirm)`);
    for (let i = 0; i < items.length; i++) {
      const val = items[i]!;
      const disp = displays[i] ?? val;
      const mark = checked.has(val) ? "[x]" : "[ ]";
      menuLine(`  ${i === cursor ? "❯" : " "} ${mark} ${disp}`);
    }
  };
  process.stdout.write("\x1b[s");
  render(true);
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(items.filter((v) => checked.has(v)));
        return;
      }
      if (key === "\u001b[A") { cursor = (cursor - 1 + items.length) % items.length; render(false); return; }
      if (key === "\u001b[B") { cursor = (cursor + 1) % items.length; render(false); return; }
      if (key.startsWith("\u001b") && key.length > 1) { return; }
      if (key === "\u001b" || key === "\u0003") { cleanup(); resolve(null); return; }
      if (key === " ") {
        const val = items[cursor]!;
        if (checked.has(val)) checked.delete(val); else checked.add(val);
        render(false);
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

/** Prompt for optional input. Returns trimmed value or empty string if skipped. */
async function promptOptional(label: string, defaultVal: string): Promise<string> {
  return new Promise((res) => {
    process.stdout.write(`${label} [${defaultVal}]: `);
    const rl = readline.createInterface({ input: process.stdin, output: null, terminal: false });
    rl.once("line", (answer) => {
      rl.close();
      process.stdout.write("\n");
      res(answer.trim() || defaultVal);
    });
  });
}

/** Read existing naia-settings/config.json (empty object if missing). */
const CAMEL_TO_NAIA_MAP: Record<string, string> = {
  agentName: "NAIA_AGENT_NAME",
  userName: "NAIA_USER_NAME",
  speechStyle: "NAIA_SPEECH_STYLE",
  honorific: "NAIA_HONORIFIC",
  extraPersona: "NAIA_EXTRA_PERSONA",
  persona: "NAIA_PERSONA",
  locale: "NAIA_LOCALE",
  provider: "NAIA_MAIN_PROVIDER",
  model: "NAIA_MAIN_MODEL",
};

function normalizeConfigKeys(cfg: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...cfg };
  for (const [camel, naia] of Object.entries(CAMEL_TO_NAIA_MAP)) {
    if (out[camel] !== undefined && out[naia] === undefined) {
      out[naia] = out[camel];
    }
  }
  return out;
}

async function readNaiaSettings(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path.join(naiaSettingsDir(), "config.json"), "utf8");
    return normalizeConfigKeys(JSON.parse(raw) as Record<string, string>);
  } catch { return {}; }
}

function readNaiaSettingsSync(): Record<string, string> {
  try {
    const raw = readFileSync(path.join(naiaSettingsDir(), "config.json"), "utf8");
    return normalizeConfigKeys(JSON.parse(raw) as Record<string, string>);
  } catch { return {}; }
}

const GLM_KNOWN_MODELS = [
  "glm-5.1",
  "glm-4.5-flash",
  "glm-4.5",
  "glm-4-plus",
  "glm-4-long",
  "glm-4-flash",
  "glm-4",
  "glm-4v-plus",
  "glm-4v",
];

async function getGlmModels(apiKey?: string): Promise<{ defaultModel: string; modelIds: string[] }> {
  if (apiKey) {
    try {
      const res = await fetch("https://open.bigmodel.cn/api/paas/v4/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { data?: { id: string }[] };
        if (data.data?.length) {
          const ids = data.data.map((m) => m.id).sort();
          return { defaultModel: ids[0], modelIds: ids };
        }
      }
    } catch { /* fallback */ }
  }
  return { defaultModel: GLM_KNOWN_MODELS[0], modelIds: [...GLM_KNOWN_MODELS] };
}

/** Write naia-settings/config.json (creates directory if needed). */
async function writeNaiaSettings(cfg: Record<string, string>): Promise<void> {
  const dir = naiaSettingsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * Save API keys to OS keychain + record key names in credentials manifest.
 * Keys are never written to disk as plaintext.
 */
async function saveApiKeys(values: Record<string, string>): Promise<void> {
  for (const [keyName, value] of Object.entries(values)) {
    const ok = keychainSet(keyName, value);
    if (ok) {
      await addCredentialKey(keyName);
      process.stdout.write(`  ✓ ${keyName} → OS keychain\n`);
    } else {
      // Keychain unavailable (headless/CI) — warn but don't block
      process.stderr.write(
        `  warn: OS keychain unavailable for ${keyName}.\n` +
        `  Set ${keyName} in environment or ${path.join(naiaSettingsDir(), "config.json")} manually.\n`,
      );
    }
  }
}

// ─── Interactive login sub-flows ──────────────────────────────────────────────

async function configureNaiaKey(): Promise<number> {
  process.stdout.write("\n── Naia (naia.nextain.io) ──\n");

  const method = await selectFromList("Login method:", [
    "Browser login  (opens naia.nextain.io — recommended)",
    "Manual key     (paste gw-xxx key)",
  ]);
  process.stdout.write("\n");
  if (method === null) return 3;

  let apiKey: string;
  let baseUrl: string;

  if (method === "Browser login  (opens naia.nextain.io — recommended)") {
    try {
      const { browserLogin } = await import("../packages/runtime/src/utils/browser-auth.js");
      const result = await browserLogin();
      apiKey = result.key;
      baseUrl = DEFAULT_GATEWAY_HTTP_URL_CLI;
      process.stdout.write(`  ✓ Received key (${apiKey.length} chars)\n`);
      if (result.userId) {
        process.stdout.write(`  ✓ User ID: ${result.userId}\n`);
      }
    } catch (err) {
      process.stderr.write(`  Browser login failed: ${(err as Error).message}\n`);
      process.stderr.write(`  Falling back to manual key entry.\n\n`);
      apiKey = (await promptLine("Naia AnyLLM API key", true)) ?? "";
      if (!apiKey) return 3;
      baseUrl = DEFAULT_GATEWAY_HTTP_URL_CLI;
    }
  } else {
    apiKey = (await promptLine("Naia AnyLLM API key", true)) ?? "";
    if (!apiKey) return 3;
    baseUrl = DEFAULT_GATEWAY_HTTP_URL_CLI;
  }

  const meta = await getNaiaRegistryMeta();
  const items = meta.modelIds.length > 0 ? meta.modelIds : [meta.defaultModel];
  process.stdout.write("\n");
  const picked = await selectFromList("Model:", items);
  if (picked === null) return 3;

  await saveApiKeys({ NAIA_ANYLLM_API_KEY: apiKey, NAIA_ANYLLM_BASE_URL: baseUrl });
  const cfg = await readNaiaSettings();
  cfg["NAIA_MAIN_PROVIDER"] = "naia";
  cfg["NAIA_MAIN_MODEL"] = picked;
  await writeNaiaSettings(cfg);
  process.stdout.write(`  ✓ Naia configured (model: ${picked})\n`);
  return 0;
}

async function configureMainLlm(): Promise<number> {
  while (true) {
    process.stdout.write("\n── main LLM ──\n");
    const provider = await selectFromList("Provider:", Object.keys(LOGIN_PROVIDERS));
    process.stdout.write("\n");
    if (!provider) { process.stderr.write("aborted\n"); return 3; }

    let model: string;

    if (provider === "claude-code") {
      try {
        const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
        createClaudeCode();
        process.stdout.write("  ✓ Claude Code subscription detected\n\n");
      } catch {
        process.stderr.write("  ✗ Claude Code not available — install and login first: npm install -g @anthropic-ai/claude-code && claude login\n");
        continue;
      }
      const picked = await selectFromList("Model:", CLAUDE_CODE_MODELS);
      if (picked === null) continue;
      model = picked.split(/\s+/)[0];
      const cfg = await readNaiaSettings();
      cfg["NAIA_MAIN_PROVIDER"] = "claude-code";
      cfg["NAIA_MAIN_MODEL"] = model;
      await writeNaiaSettings(cfg);
      process.stdout.write(`  ✓ main LLM → claude-code / ${model}\n`);
      return 0;
    }

    const fields = LOGIN_PROVIDERS[provider]!;
    const keyValues: Record<string, string> = {};
    let goBack = false;
    for (const field of fields) {
      const val = await promptLine(field.label, field.secret ?? false);
      if (val === null) {
        if (field.optional) continue;
        goBack = true; break;
      }
      keyValues[field.envKey] = val;
    }
    if (goBack) continue;

    if (provider === "naia") {
      const meta = await getNaiaRegistryMeta();
      const items = meta.modelIds.length > 0 ? meta.modelIds : [meta.defaultModel];
      process.stdout.write("\n");
      const picked = await selectFromList("Model:", items);
      if (picked === null) continue;
      model = picked;
    } else if (provider === "glm") {
      const glmMeta = await getGlmModels(keyValues["GLM_API_KEY"]);
      const items = glmMeta.modelIds.length > 0 ? glmMeta.modelIds : [glmMeta.defaultModel];
      process.stdout.write("\n");
      const picked = await selectFromList("Model:", items);
      if (picked === null) continue;
      model = picked;
    } else {
      const defaultModel = PROVIDER_DEFAULTS[provider] ?? "";
      model = await promptOptional("Model", defaultModel);
    }
    await saveApiKeys(keyValues);

    const cfg = await readNaiaSettings();
    cfg["NAIA_MAIN_PROVIDER"] = provider;
    cfg["NAIA_MAIN_MODEL"] = model;
    await writeNaiaSettings(cfg);
    process.stdout.write(`  ✓ main LLM → ${path.join(naiaSettingsDir(), "config.json")}\n`);
    return 0;
  }
}

async function addAgent(): Promise<number> {
  process.stdout.write("\n── agents ──\n");
  const cfg = await readNaiaSettings();
  const existing = (cfg["NAIA_AGENTS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const selected = await selectMultiple("Agents:", AGENT_TYPES, AGENT_DISPLAYS, existing);
  process.stdout.write("\n");
  if (selected === null) { process.stderr.write("aborted\n"); return 3; }

  cfg["NAIA_AGENTS"] = selected.join(",");
  await writeNaiaSettings(cfg);
  process.stdout.write(`  ✓ NAIA_AGENTS=${cfg["NAIA_AGENTS"] || "(none)"}\n`);
  if (selected.includes("pi")) {
    process.stdout.write(`  (pi: auto-installed on first use via npx @earendil-works/pi-coding-agent)\n`);
  }
  const others = selected.filter((a) => a !== "pi");
  if (others.length > 0) {
    process.stdout.write(`  (${others.join(", ")}: configure auth separately if needed)\n`);
  }
  return 0;
}

async function configureEmbedLlm(): Promise<number> {
  process.stdout.write("\n── embedding LLM ──\n");
  const embedProviders = Object.keys(EMBED_DEFAULTS);
  const provider = await selectFromList("Provider:", embedProviders);
  process.stdout.write("\n");
  if (!provider) { process.stderr.write("aborted\n"); return 3; }

  const fields = LOGIN_PROVIDERS[provider];
  if (fields) {
    const keyValues: Record<string, string> = {};
    for (const field of fields) {
      const val = await promptLine(field.label, field.secret ?? false);
      if (val === null) { process.stderr.write("aborted\n"); return 3; }
      keyValues[field.envKey] = val;
    }
    await saveApiKeys(keyValues);
  }

  const defaultModel = EMBED_DEFAULTS[provider] ?? "";
  const model = await promptOptional("Model", defaultModel);

  const cfg = await readNaiaSettings();
  cfg["NAIA_EMBED_PROVIDER"] = provider;
  cfg["NAIA_EMBED_MODEL"] = model;
  await writeNaiaSettings(cfg);
  process.stdout.write(`  ✓ embedding → ${path.join(naiaSettingsDir(), "config.json")}\n`);
  return 0;
}

type OnboardingStep =
  | "welcome"
  | "agentName"
  | "userName"
  | "speechStyle"
  | "provider"
  | "complete";

const ONBOARDING_STEPS: OnboardingStep[] = [
  "welcome",
  "agentName",
  "userName",
  "speechStyle",
  "provider",
  "complete",
];

function onboardingChat(step: OnboardingStep, agentName: string, userName: string): string {
  const n = agentName || "나이아";
  const u = userName ? `${userName}님` : "";
  switch (step) {
    case "welcome":
      return "안녕하세요! 시작하기 전에 잠깐 확인해 주세요";
    case "agentName":
      return "안녕하세요! 저는 나이아예요. 제 이름을 지어주세요!";
    case "userName":
      return `${n}! 정말 좋은 이름이에요. 그럼 저는 당신을 어떻게 부를까요?`;
    case "speechStyle":
      return `${u || ""} 어떤 말투로 대화할까요? 편한 걸 골라주세요`;
    case "provider":
      return "거의 다 왔어요! 저의 두뇌를 연결해 주세요";
    case "complete":
      return `${u ? u + ", " : ""}준비 완료! ${n}와 함께 시작해요!`;
  }
}

const SUPPORTED_LOCALES = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ru", label: "Русский" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];

async function runOnboarding(): Promise<number> {
  const cfg = await readNaiaSettings();
  let agentName = cfg["NAIA_AGENT_NAME"] || "";
  let userName = cfg["NAIA_USER_NAME"] || "";
  let speechStyle: "casual" | "formal" = (cfg["NAIA_SPEECH_STYLE"] as "casual" | "formal") || "casual";
  let honorific = cfg["NAIA_HONORIFIC"] || "";
  let extraPersona = cfg["NAIA_EXTRA_PERSONA"] || "";
  let locale = cfg["NAIA_LOCALE"] || "ko";

  const stepIdx = (s: OnboardingStep) => ONBOARDING_STEPS.indexOf(s);
  let current: OnboardingStep = "welcome";

  function printStep() {
    process.stdout.write(`\n── ${onboardingChat(current, agentName, userName)} ──\n\n`);
  }

  // ── Step: welcome + language ──
  current = "welcome";
  printStep();
  process.stdout.write("  Naia Agent — Open Source AI Companion\n\n");
  const langChoice = await selectFromList("Language / 언어:", SUPPORTED_LOCALES.map((l) => `${l.code}  ${l.label}`));
  if (langChoice) locale = langChoice.split(/\s+/)[0];

  // ── Step: agentName ──
  current = "agentName";
  printStep();
  {
    const val = await promptLine("Agent name (Enter = Naia)");
    if (val !== null && val.trim()) agentName = val.trim();
    else agentName = "Naia";
  }

  // ── Step: userName ──
  current = "userName";
  printStep();
  {
    const val = await promptLine("Your name");
    if (val !== null && val.trim()) userName = val.trim();
  }

  // ── Step: speechStyle ──
  current = "speechStyle";
  printStep();
  {
    const styleChoice = await selectFromList("Speech style:", [
      "casual  (반말 — 친근하고 따뜻하게)",
      "formal  (존댓말 — 정중하고 예의 바르게)",
    ]);
    if (styleChoice) speechStyle = styleChoice.startsWith("casual") ? "casual" : "formal";
    const hon = await promptLine("Honorific / 호칭 (선택, 예: 선생님, 대표님)");
    if (hon !== null && hon.trim()) honorific = hon.trim();
    const persona = await promptLine("Extra persona (선택 — 성격, 말투, 행동 규칙 등)");
    if (persona !== null && persona.trim()) extraPersona = persona.trim();
  }

  // ── Step: provider (LLM) — MANDATORY, cannot skip ──
  current = "provider";
  printStep();
  {
    const providerChoice = await selectFromList("Connect:", [
      "naia login  (naia.nextain.io — 추천)",
      "main LLM    (직접 프로바이더 설정)",
    ]);
    if (providerChoice === null || providerChoice.startsWith("naia login")) {
      const result = await configureNaiaKey();
      if (result !== 0) {
        process.stdout.write("\n  naia 로그인 없이 main LLM을 설정합니다.\n");
        const mainResult = await configureMainLlm();
        if (mainResult !== 0) {
          process.stderr.write("  LLM 설정이 필요합니다. 다시 실행해 주세요.\n");
          return 3;
        }
      }
    } else {
      const mainResult = await configureMainLlm();
      if (mainResult !== 0) {
        process.stderr.write("  LLM 설정이 필요합니다. 다시 실행해 주세요.\n");
        return 3;
      }
    }
  }

  // ── Save persona config ──
  const speechDesc =
    speechStyle === "casual"
      ? "casually and warmly"
      : "formally and professionally";
  const personaBase = `You are ${agentName.trim() || "Naia"}, an AI companion. Speak ${speechDesc}.`;
  const persona = extraPersona?.trim()
    ? `${personaBase}\n\n${extraPersona.trim()}`
    : personaBase;

  const finalCfg = await readNaiaSettings();
  finalCfg["NAIA_AGENT_NAME"] = agentName;
  finalCfg["NAIA_USER_NAME"] = userName;
  finalCfg["NAIA_SPEECH_STYLE"] = speechStyle;
  finalCfg["NAIA_HONORIFIC"] = honorific;
  finalCfg["NAIA_EXTRA_PERSONA"] = extraPersona;
  finalCfg["NAIA_PERSONA"] = persona;
  finalCfg["NAIA_LOCALE"] = locale;
  finalCfg["onboardingComplete"] = "true";
  await writeNaiaSettings(finalCfg);

  const adkDir = resolveAdkPath();
  if (!process.env["NAIA_ADK_PATH"]) {
    const bootstrapDir = path.join(homedir(), ".naia-agent");
    try {
      await mkdir(bootstrapDir, { recursive: true });
      await writeFile(
        path.join(bootstrapDir, "config.json"),
        JSON.stringify({ adkPath: adkDir, naiaAdkPath: adkDir, version: "0.0.1" }, null, 2) + "\n",
        "utf8",
      );
    } catch { /* non-fatal */ }
  }

  // ── Step: complete ──
  current = "complete";
  printStep();
  process.stdout.write(`  ✓ ${agentName} 준비 완료!\n\n`);
  return 0;
}

async function runLogin(argv: string[]): Promise<number> {
  let provider: string | undefined;
  let adkPath: string | undefined;
  let mainSpec: string | undefined;
  let subSpec: string | undefined;
  let embeddedSpec: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") provider = argv[++i];
    else if (argv[i] === "--adk") adkPath = argv[++i];
    else if (argv[i] === "--main") mainSpec = argv[++i];
    else if (argv[i] === "--sub") subSpec = argv[++i];
    else if (argv[i] === "--embedded") embeddedSpec = argv[++i];
  }

  if (adkPath) {
    if (!mainSpec && !subSpec && !embeddedSpec) {
      process.stderr.write(
        "usage: naia-agent login --adk <path> --main <provider|baseUrl|model[|apiKeyRef]>\n" +
        "                               [--sub <spec>] [--embedded <spec>]\n",
      );
      return 3;
    }
    const roles: Record<string, ParsedRole> = {};
    if (mainSpec) {
      const r = parseRoleSpec(mainSpec, false);
      if (!r.ok) { process.stderr.write(`naia-agent login: --main: ${r.err}\n`); return 3; }
      roles.main = r.role;
    }
    if (subSpec) {
      const r = parseRoleSpec(subSpec, false);
      if (!r.ok) { process.stderr.write(`naia-agent login: --sub: ${r.err}\n`); return 3; }
      roles.sub = r.role;
    }
    if (embeddedSpec) {
      const r = parseRoleSpec(embeddedSpec, true);
      if (!r.ok) { process.stderr.write(`naia-agent login: --embedded: ${r.err}\n`); return 3; }
      roles.embedded = r.role;
    }
    const settingsDir = path.join(adkPath, "naia-settings");
    mkdirSync(settingsDir, { recursive: true });
    const llmPath = path.join(settingsDir, "llm.json");
    let existing: Record<string, unknown> = { version: 1 };
    try {
      if (existsSync(llmPath)) existing = JSON.parse(readFileSync(llmPath, "utf8")) as Record<string, unknown>;
    } catch { /* overwrite */ }
    const merged = { ...existing, ...roles };
    writeFileSync(llmPath, JSON.stringify(merged, null, 2) + "\n");

    const configDir = path.join(homedir(), ".naia-agent");
    mkdirSync(configDir, { recursive: true });
    const configJsonPath = path.join(configDir, "config.json");
    let config: Record<string, unknown> = {};
    try {
      if (existsSync(configJsonPath)) config = JSON.parse(readFileSync(configJsonPath, "utf8")) as Record<string, unknown>;
    } catch { /* overwrite */ }
    config.naiaAdkPath = adkPath;
    writeFileSync(configJsonPath, JSON.stringify(config, null, 2) + "\n");

    const roleNames = Object.keys(roles).join(", ");
    process.stderr.write(
      `naia-agent login: configured (${roleNames})\n` +
      `  Run: pnpm naia-agent --no-tools "your prompt here"\n`,
    );
    return 0;
  }

  // ── Shortcut: login naia → browser login + model select → done ──
  if (argv[0] === "naia") {
    return configureNaiaKey();
  }

  // ── Shortcut: login anthropic / openai / glm / vertex → direct --key flow ──
  const directProviders = new Set(["anthropic", "openai", "glm", "vertex", "vllm", "ollama"]);
  if (argv[0] && directProviders.has(argv[0])) {
    provider = argv[0];
  }

  // ── Legacy --key flow (backwards compat + non-TTY tests) ──
  if (provider) {
    const fields = LOGIN_PROVIDERS[provider.toLowerCase()];
    if (!fields) {
      process.stderr.write(
        `naia-agent login: unknown provider "${provider}"\n` +
        `  supported: ${Object.keys(LOGIN_PROVIDERS).join(" | ")}\n`,
      );
      return 3;
    }
    if (!process.stdin.isTTY) {
      process.stderr.write(`naia-agent login: stdin must be a TTY for interactive key entry\n`);
      return 3;
    }
    const values: Record<string, string> = {};
    for (const field of fields) {
      const val = await promptLine(field.label, field.secret ?? false);
      if (val === null) { process.stderr.write(`naia-agent login: aborted\n`); return 3; }
      values[field.envKey] = val;
    }
    await saveApiKeys(values);
    return 0;
  }

  // ── No recognized flags / non-TTY: usage ──
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "naia-agent login: missing --key <provider> or --adk <path>\n" +
      "usage: naia-agent login --adk <path> --main <provider|baseUrl|model[|apiKeyRef]>\n" +
      "                               [--sub <spec>] [--embedded <spec>]\n" +
      "       naia-agent login --key <provider>\n" +
      "       naia-agent login naia                  # browser login -> model select -> done\n" +
      "       naia-agent login <provider>            # anthropic | openai | glm | vertex\n" +
      "\n" +
      "  Role spec: provider|baseUrl|model[|apiKeyRef]\n" +
      "  Embedded:  provider|baseUrl|model|dims[|apiKeyRef]\n",
    );
    return 3;
  }

  // ── Interactive loop ──
  while (true) {
    const cfg = await readNaiaSettings();
    const credKeys = await readCredentialKeys();

    const naiaHint = credKeys.includes("NAIA_ANYLLM_API_KEY") ? "✓" : "";
    const mainHint = cfg["NAIA_MAIN_PROVIDER"]
      ? `${cfg["NAIA_MAIN_PROVIDER"]} / ${cfg["NAIA_MAIN_MODEL"] ?? ""}`
      : "";
    const agentsHint = cfg["NAIA_AGENTS"] ?? "";
    const embedHint = cfg["NAIA_EMBED_PROVIDER"]
      ? `${cfg["NAIA_EMBED_PROVIDER"]} / ${cfg["NAIA_EMBED_MODEL"] ?? ""}`
      : "";

    const menuItems = [
      { label: "naia key  (naia.nextain.io — simplest)", hint: naiaHint },
      { label: "main LLM",                              hint: mainHint },
      { label: "agents  (multi-select)",                 hint: agentsHint },
      { label: "embedding LLM",                         hint: embedHint },
      { label: "start chat  →  pnpm naia-agent" },
      { label: "done" },
    ];

    const idx = await selectFromMenu("Configure:", menuItems);
    process.stdout.write("\n");
    if (idx === null || idx === menuItems.length - 1) return 0; // Ctrl+C or 완료

    if (idx === 0) await configureNaiaKey();
    else if (idx === 1) await configureMainLlm();
    else if (idx === 2) await addAgent();
    else if (idx === 3) await configureEmbedLlm();
    else if (idx === 4) {
      process.stdout.write("  To start chat: pnpm naia-agent\n");
      return 0;
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// ─── login subcommand — persist naia-settings/llm.json + OS-keychain keys ──
//
// Writes the cross-repo 3-role config to <adk>/naia-settings/llm.json
// (provider/baseUrl/model/apiKeyRef/dims ONLY — never a raw key) and the
// naia-adk path to ~/.naia-agent/config.json. `--key REF=VALUE` stores the
// secret in the OS keychain (device-key encrypted); if the keychain is
// unavailable it REFUSES (no plaintext fallback) and tells the user to use
// an env var. The value is never written to disk nor printed.

// ─── providers subcommand — list providers and models ─────────────────────
async function runProviders(): Promise<number> {
  const { listProviders, fetchNaiaPricing } = await import("../packages/providers/src/registry.js");
  const providers = listProviders();
  const pricingModels = await fetchNaiaPricing();
  const pricingMap = new Map((pricingModels ?? []).map((m) => [m.id, m.pricing]));

  for (const p of providers) {
    process.stdout.write(`\n── ${p.name} (${p.id}) ──\n`);
    if (p.isLocal) {
      process.stdout.write(`  ${p.description}\n  (local — models discovered at runtime)\n`);
      continue;
    }
    for (const m of p.models) {
      const pricing = pricingMap.get(m.id) ?? m.pricing;
      const priceStr = pricing ? `  $${pricing[0].toFixed(3)} / $${pricing[1].toFixed(3)}` : "";
      const caps = m.capabilities.filter((c) => c !== "llm").join(",");
      const capStr = caps ? `  [${caps}]` : "";
      const marker = m.id === p.defaultModel ? " (default)" : "";
      process.stdout.write(`  ${m.id}${marker}${capStr}${priceStr}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

// ─── show subcommand — read-only config inspection (no secret values) ──────
function runShow(): number {
  const adk = process.env["NAIA_ADK_PATH"];
  let llmPath = "";
  let llm: { main?: ParsedRole; sub?: ParsedRole; embedded?: ParsedRole } = {};
  if (adk) {
    llmPath = path.join(adk, "naia-settings", "llm.json");
    try {
      if (existsSync(llmPath)) llm = JSON.parse(readFileSync(llmPath, "utf8")) as typeof llm;
    } catch {
      /* keep llmPath; show missing/unreadable below */
    }
  }
  const role = (name: string, r: ParsedRole | undefined): string => {
    if (!r) return `  ${name.padEnd(10)} <none>`;
    const ref = r.apiKeyRef ? `  apiKeyRef=${r.apiKeyRef}` : "";
    const dims = r.dims ? `  dims=${r.dims}` : "";
    return `  ${name.padEnd(10)} ${r.provider} ${r.model} @ ${r.baseUrl}${dims}${ref}`;
  };
  const env = process.env;
  // mirror buildLLMClient's resolution order — what would run now
  let resolved = "<none \u2014 set ANTHROPIC_API_KEY / OPENAI_API_KEY+OPENAI_BASE_URL / GLM_API_KEY, or naia-agent login>";
  if (env["ANTHROPIC_API_KEY"]) resolved = `anthropic ${env["ANTHROPIC_MODEL"] ?? "<default>"}`;
  else if (env["OPENAI_API_KEY"] && env["OPENAI_BASE_URL"])
    resolved = `openai-compat ${env["OPENAI_MODEL"] ?? "<default>"} @ ${env["OPENAI_BASE_URL"]}`;
  else if (env["GLM_API_KEY"]) resolved = `glm ${env["GLM_MODEL"] ?? "<default>"}`;
  const memDb = env["NAIA_AGENT_MEMORY_DB"] ?? path.join(homedir(), ".naia-agent", "memory", "cli.sqlite");
  const memExists = existsSync(memDb);
  const cfgJson = path.join(homedir(), ".naia-agent", "config.json");
  process.stdout.write(
    `naia-agent show — current configuration (no secret values)\n` +
      `  naia-adk:    ${adk ?? "<unset>"}\n` +
      `  llm.json:    ${llmPath || "<n/a>"}${llmPath && !existsSync(llmPath) ? "  (missing)" : ""}\n` +
      `${role("main", llm.main)}\n` +
      `${role("sub", llm.sub)}\n` +
      `${role("embedded", llm.embedded)}\n` +
      `  resolved:    ${resolved}\n` +
      `  memory db:   ${memDb}  (${memExists ? "exists" : "absent"})\n` +
      `  config.json: ${cfgJson}\n` +
      `  (apiKeyRef shows the env var / keychain NAME only — values are never printed.)\n`,
  );
  return 0;
}

/** Returns true if at least one LLM provider env is set (after env-load + keychain).
 *  Must mirror buildLLMClient() exactly — a false-positive here skips auto-redirect
 *  to login, then buildLLMClient() returns null and the process exits 3 with a
 *  confusing error (R2-A Q3 cross-review finding).
 */
function hasLLMConfig(): boolean {
  const e = process.env;
  return !!(
    // naia: KEY + BASE_URL alone is not enough — NAIA_MAIN_MODEL also required
    // (buildLLMClient naia path returns null if NAIA_MAIN_MODEL is missing/auto)
    (e.NAIA_ANYLLM_API_KEY && e.NAIA_ANYLLM_BASE_URL &&
      e.NAIA_MAIN_MODEL && e.NAIA_MAIN_MODEL !== "auto") ||
    e.ANTHROPIC_API_KEY ||
    (e.OPENAI_API_KEY && e.OPENAI_BASE_URL) ||
    e.OPENAI_BASE_URL ||  // ollama / vllm without API key (no-auth local server)
    e.GLM_API_KEY ||
    (e.VERTEX_PROJECT_ID && e.VERTEX_REGION)
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // login subcommand — handled before env-load (login writes the env file)
  if (argv[0] === "login") {
    return runLogin(argv.slice(1));
  }

  // providers subcommand — list providers and models (no auth needed)
  if (argv[0] === "providers") {
    return runProviders();
  }

  // Parse args early so usage errors exit immediately (before slow keychain load).
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`naia-agent: ${parsed.error}\n`);
    process.stderr.write(
      "usage: pnpm naia-agent [prompt] [--mode=direct|supervisor] [--workdir DIR] [--debug]\n" +
      "       pnpm naia-agent [prompt] [--no-tools] [--no-default-system] [--memory] [--system \"...\"]\n" +
      "       pnpm naia-agent [prompt] [--compact-strategy reactive|realtime|anthropic-native|off]\n" +
      "       pnpm naia-agent login --adk <path> [--main ...] [--sub ...] [--embedded ...] [--key REF=VAL]\n" +
      "       pnpm naia-agent show                       # show current config (no secret values)\n" +
      "       pnpm naia-agent providers                   # list providers and models\n" +
      "       pnpm naia-agent --stdio\n" +
      "       pnpm naia-agent [prompt] --service app.service.json\n" +
      "       pnpm naia-agent [prompt] --mode=supervisor [--no-verify] [-m model] [--adapter shell -- cmd args]\n" +
      "       pnpm naia-agent login naia                  # browser login -> model select -> done\n" +
      "       pnpm naia-agent login anthropic            # direct API key entry\n",
    );
    return 3;
  }

  // S2/S3: auto-load ~/.naia-agent/.env + {NAIA_ADK_PATH}/naia-settings/config.json
  // process.env keys already set are never overwritten (first-match-wins).
  loadEnvAndConfig();

  // Load API keys from OS keychain (credentials manifest → keychain → process.env).
  // Only injects keys not already set by env/file sources above (undefined check:
  // empty string "" means caller explicitly cleared it, e.g. tests — do NOT overwrite).
  const credKeys = await readCredentialKeys();
  for (const keyName of credKeys) {
    if (process.env[keyName] === undefined) {
      const val = keychainGet(keyName);
      if (val) process.env[keyName] = val;
    }
  }

  // show subcommand — read-only config inspection (after env+keychain load so
  // resolved/keychain references are populated).
  if (argv[0] === "show") return runShow();

  // Stdio IPC mode: enter readline JSON loop before login redirect check
  // (credentials arrive dynamically via auth_update, so hasLLMConfig() is false at startup).
  if (parsed.stdio) {
    return runStdio();
  }

  // If no LLM provider is configured and we're on a TTY, auto-redirect to onboarding.
  if (!hasLLMConfig() && process.stdin.isTTY) {
    const cfg = await readNaiaSettings();
    const isFirstRun = !cfg["onboardingComplete"];
    if (isFirstRun) {
      process.stdout.write("naia-agent: first run — starting setup.\n");
      const result = await runOnboarding();
      if (result !== 0) return result;
    } else {
      process.stdout.write("naia-agent: no LLM provider configured — starting setup.\n\n");
      const loginResult = await runLogin([]);
      if (loginResult !== 0) return loginResult;
    }
    // Reload env after login so newly saved keys are available
    loadEnvAndConfig();
    const credKeys2 = await readCredentialKeys();
    for (const keyName of credKeys2) {
      if (process.env[keyName] === undefined) {
        const val = keychainGet(keyName);
        if (val) process.env[keyName] = val;
      }
    }
  }

  if (parsed.service !== undefined) {
    return runService(parsed);
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
