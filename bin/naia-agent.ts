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
import { access as fsAccess, readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
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
  loadEnvAndConfig,
  getSecretStore,
  parseRoleSpec,
  readConfiguredAdkPath,
} from "@nextain/agent-runtime";
import type { ServiceManifest, ParsedRole } from "@nextain/agent-runtime";
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
  /** R6/SB-1 (#32, §D50) — path to a *.service.json manifest. Implies direct
   *  mode; llm/memory/persona are assembled from the manifest, not env. */
  service?: string;
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
  /** Attach no tools to the Agent. Needed for models without native
   *  tool-calling (e.g. local Ollama gemma3n). Model-agnostic. */
  noTools: boolean;
  /** Omit the built-in DEFAULT_SYSTEM_PROMPT behavioral contract. Small
   *  models are degraded by the long English contract (#41 v2, measured).
   *  Model-agnostic — any host with its own prompt / tight budget. */
  noDefaultSystem: boolean;
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
    noTools: false,
    noDefaultSystem: false,
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
  const tools = new InMemoryToolExecutor(args.noTools ? [] : [createBashSkill()]);
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
    appendDefaultSystemPrompt: !args.noDefaultSystem,
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
      const ok = await safeTurn(agent, args.prompt, args.debug);
      return ok ? 0 : 2;
    }

    // REPL mode — requires TTY
    if (!process.stdin.isTTY) {
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
      await safeTurn(agent, trimmed, args.debug); // never throws → REPL survives
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
    tools: new InMemoryToolExecutor(args.noTools ? [] : [createBashSkill()]),
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
    const url =
      process.env["OPENAI_BASE_URL"] ?? process.env["ANTHROPIC_BASE_URL"] ?? process.env["GLM_BASE_URL"];
    process.stderr.write(
      `\nnaia-agent: turn failed — ${msg}\n` +
        (conn
          ? `  The model server${url ? ` at ${url}` : ""} is unreachable. Start it, or reconfigure:\n` +
            `    pnpm naia-agent login --adk <naia-adk> \\\n` +
            `      --main "openai-compat|http://127.0.0.1:11434/v1|gemma3n:e4b"\n`
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

// ─── login subcommand — persist naia-settings/llm.json + OS-keychain keys ──
//
// Writes the cross-repo 3-role config to <adk>/naia-settings/llm.json
// (provider/baseUrl/model/apiKeyRef/dims ONLY — never a raw key) and the
// naia-adk path to ~/.naia-agent/config.json. `--key REF=VALUE` stores the
// secret in the OS keychain (device-key encrypted); if the keychain is
// unavailable it REFUSES (no plaintext fallback) and tells the user to use
// an env var. The value is never written to disk nor printed.

function runLogin(argv: string[]): number {
  let adk: string | undefined;
  const roles: Record<string, ParsedRole> = {};
  const keys: Array<[string, string]> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === "--adk") adk = next();
    else if (a === "--main" || a === "--sub" || a === "--embedded") {
      const v = next();
      if (!v) return usageLogin(`${a} requires a value`);
      const r = parseRoleSpec(v, a === "--embedded");
      if (!r.ok) return usageLogin(`${a}: ${r.err}`);
      roles[a.slice(2)] = r.role;
    } else if (a === "--key") {
      const v = next();
      const eq = v ? v.indexOf("=") : -1;
      if (!v || eq <= 0) return usageLogin(`--key must be REF=VALUE`);
      keys.push([v.slice(0, eq), v.slice(eq + 1)]);
    } else {
      return usageLogin(`unknown arg: ${a}`);
    }
  }

  adk = adk ?? process.env["NAIA_ADK_PATH"] ?? readConfiguredAdkPath();
  if (!adk) return usageLogin("no naia-adk path — pass --adk <path> (or set NAIA_ADK_PATH)");
  if (!existsSync(adk)) return usageLogin(`--adk path does not exist: ${adk}`);

  // Store keys in the OS keychain. NO plaintext fallback.
  if (keys.length > 0) {
    const store = getSecretStore();
    if (!store.available()) {
      process.stderr.write(
        `naia-agent login: ERROR — OS keychain unavailable; refusing to store a key in plaintext.\n` +
          `  Export the secret in your shell environment (NOT a file), then reference it\n` +
          `  by name via apiKeyRef in the role spec\n` +
          `  (e.g. export ANTHROPIC_API_KEY=... ; --main "anthropic|...|model|ANTHROPIC_API_KEY").\n`,
      );
      return 2;
    }
    for (const [ref, value] of keys) {
      if (!store.set(ref, value)) {
        process.stderr.write(`naia-agent login: ERROR — failed to store key "${ref}" in OS keychain.\n`);
        return 2;
      }
    }
  }

  // Merge into existing llm.json (preserve roles not being changed).
  const settingsDir = path.join(adk, "naia-settings");
  const llmPath = path.join(settingsDir, "llm.json");
  let llm: Record<string, unknown> = { version: 1 };
  try {
    if (existsSync(llmPath)) llm = JSON.parse(readFileSync(llmPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* start fresh on unreadable existing file */
  }
  llm["version"] = 1;
  for (const [k, v] of Object.entries(roles)) llm[k] = v;
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(llmPath, `${JSON.stringify(llm, null, 2)}\n`);

  // Persist the adk path so future runs need no NAIA_ADK_PATH export.
  const cfgDir = path.join(homedir(), ".naia-agent");
  const cfgPath = path.join(cfgDir, "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* overwrite unreadable */
  }
  cfg["naiaAdkPath"] = adk;
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  try {
    chmodSync(cfgPath, 0o600);
  } catch {
    /* best effort */
  }

  process.stderr.write(
    `naia-agent login: configured.\n` +
      `  naia-adk:   ${adk}\n` +
      `  llm.json:   ${llmPath}\n` +
      Object.entries(roles)
        .map(([r, v]) => `  ${r}: ${String(v["provider"])} ${String(v["model"])}${v["apiKeyRef"] ? ` (key→${String(v["apiKeyRef"])})` : ""}\n`)
        .join("") +
      (keys.length > 0 ? `  keychain:   stored ${keys.map(([r]) => r).join(", ")} (device-key encrypted)\n` : "") +
      `Run: pnpm naia-agent --no-tools "your prompt"\n`,
  );
  return 0;
}

function usageLogin(err: string): number {
  process.stderr.write(
    `naia-agent login: ${err}\n` +
      `usage: pnpm naia-agent login --adk <path>\n` +
      `         [--main "provider|baseUrl|model[|apiKeyRef]"]\n` +
      `         [--sub  "provider|baseUrl|model[|apiKeyRef]"]\n` +
      `         [--embedded "provider|baseUrl|model|dims[|apiKeyRef]"]\n` +
      `         [--key REF=VALUE]   (stored in OS keychain, never plaintext)\n`,
  );
  return 3;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "login") return runLogin(argv.slice(1));
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`naia-agent: ${parsed.error}\n`);
    process.stderr.write(
      `usage: pnpm naia-agent [prompt] [--mode=direct|supervisor] [--workdir DIR] [--debug]\n` +
      `       pnpm naia-agent [prompt] --service app.service.json\n` +
      `       pnpm naia-agent [prompt] --mode=supervisor [--no-verify] [-m model] [--adapter shell -- cmd args]\n`,
    );
    return 3;
  }

  // Auto-load config so the documented resolution actually applies:
  //   process.env  >  naia-settings/llm.json (NAIA_ADK_PATH)  >  .env files
  // Only sets keys that are unset — process.env always wins.
  loadEnvAndConfig();

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
