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
import { access as fsAccess, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { Agent } from "@nextain/agent-core";
import type { HostContext, LLMClient, MemoryProvider } from "@nextain/agent-types";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";
import {
  InMemoryMemory,
  InMemoryToolExecutor,
  createBashSkill,
  parseServiceManifest,
  resolveMemoryBinding,
  manifestBaseURLTrust,
  manifestInvalid,
  parseEnv,
  loadEnvAndConfig,
  checkDuplicateKeys,
  buildEnvAppend,
} from "@nextain/agent-runtime";
import type { ServiceManifest } from "@nextain/agent-runtime";
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

// ─── Args ────────────────────────────────────────────────────────────────────

type Mode = "direct" | "supervisor";

interface Args {
  mode: Mode;
  prompt: string;
  workdir: string;
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
    } else if (a === "--service") {
      const v = argv[++i];
      if (!v) return { error: "--service requires a path to a *.service.json manifest" };
      args.service = v;
      args.mode = "direct";
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

// ─── Provider resolution (direct mode) ──────────────────────────────────────

async function buildLLMClient(): Promise<LLMClient | null> {
  const env = process.env;

  // Naia AnyLLM gateway (OpenAI-compatible, takes priority over plain OPENAI_*)
  if (env.NAIA_ANYLLM_API_KEY && env.NAIA_ANYLLM_BASE_URL) {
    const model = env.NAIA_MAIN_MODEL && env.NAIA_MAIN_MODEL !== "auto"
      ? env.NAIA_MAIN_MODEL
      : undefined;
    if (!model) {
      process.stderr.write(
        `naia-agent: ERROR — NAIA_MAIN_MODEL not set.\n` +
        `  Run: pnpm naia-agent login → main LLM → select model\n`,
      );
      return null;
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
    const model = env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
    const anthropic = createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL && { baseURL: env.ANTHROPIC_BASE_URL }),
    });
    process.stderr.write(`naia-agent: provider=anthropic model=${model}\n`);
    return new VercelClient(anthropic(model));
  }

  if (env.OPENAI_BASE_URL) {
    // Covers: openai-compat (with key) + ollama/vllm (no-auth local servers).
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const model = env.NAIA_MAIN_MODEL || env.OPENAI_MODEL || "llama3.2";
    const provider = createOpenAICompatible({
      name: "openai-compat",
      apiKey: env.OPENAI_API_KEY ?? "",  // ollama accepts empty key
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

  // Test-only hermetic provider gate. Same pattern as runService DRYRUN.
  // Proves provider was configured (env-loader wiring) without any LLM call.
  if (process.env.NAIA_AGENT_DRYRUN === "1") {
    process.stderr.write(`naia-agent: dry-run OK (direct mode — provider configured)\n`);
    return 0;
  }

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

  // close the MemoryProvider on exit — agent.close() does not (cross-review
  // r1, gemini MAJOR). Harmless for InMemoryMemory, required for SQLite.
  try {
    return await executeAgent(agent, args);
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
      await streamToStdout(agent, args.prompt, args.debug);
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
    default:
      process.stderr.write(
        `naia-agent: unknown manifest llm.backend "${llm.backend}" ` +
          `(supported: openai-compatible | anthropic | vertex | claude-code)\n`,
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
    tools: new InMemoryToolExecutor([createBashSkill()]),
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
  naia: [
    { envKey: "NAIA_ANYLLM_API_KEY", label: "Naia AnyLLM API key", secret: true },
    { envKey: "NAIA_ANYLLM_BASE_URL", label: "Naia AnyLLM gateway URL (e.g. http://localhost:8000/v1)" },
  ],
  anthropic: [
    { envKey: "ANTHROPIC_API_KEY", label: "Anthropic API key (sk-ant-...)", secret: true },
  ],
  openai: [
    { envKey: "OPENAI_API_KEY",  label: "OpenAI API key", secret: true },
    { envKey: "OPENAI_BASE_URL", label: "OpenAI base URL (e.g. https://api.openai.com/v1)" },
  ],
  glm: [
    { envKey: "GLM_API_KEY", label: "Zhipu GLM API key", secret: true },
  ],
  vllm: [
    { envKey: "OPENAI_API_KEY",  label: "vLLM API key (Enter to skip)", secret: true, optional: true },
    { envKey: "OPENAI_BASE_URL", label: "vLLM base URL (e.g. http://localhost:8000/v1)" },
  ],
  ollama: [
    { envKey: "OPENAI_BASE_URL", label: "Ollama base URL", optional: true },
  ],
  vertex: [
    { envKey: "VERTEX_PROJECT_ID", label: "GCP project ID" },
    { envKey: "VERTEX_REGION",     label: "Vertex region (e.g. us-east5)" },
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
function naiaSettingsDir(): string {
  const adkPath = process.env["NAIA_ADK_PATH"] ?? path.join(homedir(), "naia-adk");
  return path.join(adkPath, "naia-settings");
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
    const reg = await import("../../naia-os/shell/src/lib/llm/registry.js");
    const p = reg.getLlmProvider("nextain");
    if (p) {
      return {
        defaultModel: p.defaultModel ?? "gemini-2.5-pro",
        modelIds: p.models.map((m: { id: string }) => m.id),
      };
    }
  } catch { /* fallback below */ }
  return {
    defaultModel: "gemini-2.5-pro",
    modelIds: [
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-live",
    ],
  };
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-opus-4-5",
  openai: "gpt-4o",
  glm: "glm-4",
  vllm: "Qwen/Qwen3-8B",
  ollama: "llama3.2",
  vertex: "claude-opus-4-5",
};

const EMBED_DEFAULTS: Record<string, string> = {
  naia: "google/text-embedding-004",
  openai: "text-embedding-3-small",
  anthropic: "voyage-3",
  vllm: "BAAI/bge-m3",
  ollama: "nomic-embed-text",
};

// Agents bundled with naia-agent (no separate download needed)
const AGENT_TYPES = ["pi", "opencode", "claude-code", "codex"] as const;
// Display labels (shown in UI; pi uses npx auto-install)
const AGENT_DISPLAYS: readonly string[] = [
  "pi           (naia — auto-installed via npx on first use)",
  "opencode",
  "claude-code",
  "codex",
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
async function readNaiaSettings(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path.join(naiaSettingsDir(), "config.json"), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch { return {}; }
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
  process.stdout.write("  Get your credentials at: naia.nextain.io\n\n");
  // Naia uses NAIA_ANYLLM_API_KEY + NAIA_ANYLLM_BASE_URL (same as main LLM "naia" path).
  const apiKey = await promptLine("Naia AnyLLM API key", true);
  if (apiKey === null) return 3;
  const baseUrl = await promptLine("Naia AnyLLM gateway URL (e.g. http://localhost:8000/v1)");
  if (baseUrl === null) return 3;

  const meta = await getNaiaRegistryMeta();
  const items = meta.modelIds.length > 0 ? meta.modelIds : [meta.defaultModel];
  process.stdout.write("\n");
  const picked = await selectFromList("Model:", items);
  // Collect all inputs before saving — avoids partial state where API key is saved
  // but NAIA_MAIN_MODEL is missing (B4 cross-review finding, R4-B).
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

    const fields = LOGIN_PROVIDERS[provider]!;
    const keyValues: Record<string, string> = {};
    let goBack = false;
    for (const field of fields) {
      const val = await promptLine(field.label, field.secret ?? false);
      if (val === null) {
        if (field.optional) continue; // ESC on optional field = skip
        goBack = true; break;         // ESC on required field = back to provider list
      }
      keyValues[field.envKey] = val;
    }
    if (goBack) continue;

    let model: string;
    if (provider === "naia") {
      const meta = await getNaiaRegistryMeta();
      const items = meta.modelIds.length > 0 ? meta.modelIds : [meta.defaultModel];
      process.stdout.write("\n");
      const picked = await selectFromList("Model:", items);
      if (picked === null) continue; // ESC/Ctrl+C = back to provider selection (nothing saved)
      model = picked;
    } else {
      const defaultModel = PROVIDER_DEFAULTS[provider] ?? "";
      model = await promptOptional("Model", defaultModel);
    }
    await saveApiKeys(keyValues); // save only after all inputs collected

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

async function runLogin(argv: string[]): Promise<number> {
  let provider: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") provider = argv[++i];
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

  // ── non-TTY without --key: usage error (tests) ──
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `naia-agent login: missing --key <provider>\n` +
      `  providers: ${Object.keys(LOGIN_PROVIDERS).join(" | ")}\n` +
      `  example:   pnpm naia-agent login --key anthropic\n`,
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

  // Parse args early so usage errors exit immediately (before slow keychain load).
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`naia-agent: ${parsed.error}\n`);
    process.stderr.write(
      `usage: pnpm naia-agent [prompt] [--mode=direct|supervisor] [--workdir DIR] [--debug]\n` +
      `       pnpm naia-agent [prompt] --service app.service.json\n` +
      `       pnpm naia-agent [prompt] --mode=supervisor [--no-verify] [-m model] [--adapter shell -- cmd args]\n` +
      `       pnpm naia-agent login --key anthropic|openai|glm|vertex\n`,
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

  // If no LLM provider is configured and we're on a TTY, auto-redirect to login.
  if (!hasLLMConfig() && process.stdin.isTTY) {
    process.stdout.write("naia-agent: no LLM provider configured — starting setup.\n\n");
    const loginResult = await runLogin([]);
    if (loginResult !== 0) return loginResult;
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
