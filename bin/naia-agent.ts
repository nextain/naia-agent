#!/usr/bin/env -S pnpm exec tsx
// bin/naia-agent — entry point. Slice 1a R3 (mock-only). Real LLM in 1b.
//
// Modes (process.stdin.isTTY decides):
//   1) args mode:   pnpm naia-agent "hi"        → 1-shot, prints answer to stdout
//   2) stdin mode:  echo "hi" | pnpm naia-agent → 1-shot, reads stdin
//   3) REPL mode:   pnpm naia-agent             → multi-turn readline loop
//
// Exit codes: 0 ok, 1 user error, 2 internal error.

import * as readline from "node:readline";
import { Agent } from "@nextain/agent-core";
import { createHost, loadEnvAndConfig } from "@nextain/agent-runtime";
import type { LLMClient } from "@nextain/agent-types";

const VERSION = "0.0.3-slice-1c";

// Slice 1b — env-detected real LLM injection.
// Convention: ANTHROPIC_API_KEY + optional ANTHROPIC_BASE_URL (for gateway
// routing). NAIA_GATEWAY_URL takes precedence as ANTHROPIC_BASE_URL when set
// AND when the gateway is Anthropic-compat. OpenAI-compat gateways are not
// supported in 1b (matrix B21 — no multi-provider direct deps; gateway
// translation lives in user environment).
async function detectRealLLM(): Promise<{ client?: LLMClient; mode: string }> {
  // Priority 1: Anthropic direct (or via ANTHROPIC_BASE_URL gateway).
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) {
    const baseURL = process.env["ANTHROPIC_BASE_URL"];
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const { AnthropicClient } = await import("@nextain/agent-providers/anthropic");
      const sdk = new Anthropic(baseURL ? { apiKey: anthropicKey, baseURL } : { apiKey: anthropicKey });
      const defaultModel = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001";
      return {
        client: new AnthropicClient(sdk, { defaultModel }),
        mode: `anthropic-direct (model=${defaultModel}${baseURL ? `, baseURL=${baseURL}` : ""})`,
      };
    } catch (err) {
      process.stderr.write(
        `[naia-agent] anthropic-direct provider load failed: ${(err as Error).message}\n` +
          `             trying Vertex AI / falling back to mock.\n`,
      );
    }
  }

  // Priority 2: OpenAI-compat (zai GLM, vLLM, OpenRouter, Together, Groq, Ollama …).
  // Detected via OPENAI_API_KEY + OPENAI_BASE_URL OR GLM_API_KEY (zai default endpoint).
  const openaiKey = process.env["OPENAI_API_KEY"];
  const openaiBase = process.env["OPENAI_BASE_URL"];
  const glmKey = process.env["GLM_API_KEY"];
  if ((openaiKey && openaiBase) || glmKey) {
    try {
      const { OpenAICompatClient } = await import("@nextain/agent-providers/openai-compat");
      const apiKey = openaiKey ?? glmKey ?? "";
      const baseUrl =
        openaiBase ??
        process.env["GLM_BASE_URL"] ??
        "https://open.bigmodel.cn/api/paas/v4";
      const model =
        process.env["OPENAI_MODEL"] ?? process.env["GLM_MODEL"] ?? "glm-4.5-flash";
      return {
        client: new OpenAICompatClient({ apiKey, baseUrl, model }),
        mode: `openai-compat (model=${model}, baseUrl=${baseUrl})`,
      };
    } catch (err) {
      process.stderr.write(
        `[naia-agent] openai-compat provider load failed: ${(err as Error).message}\n`,
      );
    }
  }

  // Priority 3: Anthropic on Vertex AI.
  const vertexProject =
    process.env["VERTEX_PROJECT_ID"] ?? process.env["GOOGLE_CLOUD_PROJECT"];
  const vertexRegion =
    process.env["VERTEX_REGION"] ?? process.env["GOOGLE_CLOUD_LOCATION"];
  if (vertexProject && vertexRegion) {
    try {
      const { createAnthropicVertexClient } = await import(
        "@nextain/agent-providers/anthropic-vertex"
      );
      const defaultModel = process.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5@20251001";
      return {
        client: createAnthropicVertexClient({
          projectId: vertexProject,
          region: vertexRegion,
          defaultModel,
        }),
        mode: `anthropic-vertex (project=${vertexProject}, region=${vertexRegion}, model=${defaultModel})`,
      };
    } catch (err) {
      process.stderr.write(
        `[naia-agent] anthropic-vertex provider load failed: ${(err as Error).message}\n` +
          `             falling back to mock. Verify @anthropic-ai/vertex-sdk + ADC (gcloud auth application-default login).\n`,
      );
    }
  }

  return { mode: "mock (no provider env detected)" };
}

interface CliArgs {
  prompt?: string;
  help: boolean;
  version: boolean;
  envPath?: string;
  configPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };
  const positional: string[] = [];
  let terminated = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (terminated) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      terminated = true;
    } else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-V") args.version = true;
    else if (a === "--env") {
      args.envPath = argv[++i];
    } else if (a.startsWith("--env=")) {
      args.envPath = a.slice("--env=".length);
    } else if (a === "--config") {
      args.configPath = argv[++i];
    } else if (a.startsWith("--config=")) {
      args.configPath = a.slice("--config=".length);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else positional.push(a);
  }
  if (positional.length > 0) args.prompt = positional.join(" ");
  return args;
}

function printHelp(): void {
  console.log(`naia-agent ${VERSION}

Usage:
  pnpm naia-agent "your prompt"             # args mode (1-shot)
  echo "prompt" | pnpm naia-agent           # stdin mode (1-shot)
  pnpm naia-agent                            # REPL mode
  pnpm naia-agent --env path/to/.env "..."  # custom .env path
  pnpm naia-agent --config ~/cfg.json "..."  # custom JSON config path

Flags:
  -h, --help        show this help
  -V, --version     show version
  --env <path>      .env file path (or NAIA_AGENT_ENV)
  --config <path>   JSON config path (or NAIA_AGENT_CONFIG)

Provider resolution (first match wins):
  1) ANTHROPIC_API_KEY  → Anthropic direct (claude-haiku-4-5-20251001 default)
                          + ANTHROPIC_BASE_URL → Anthropic-compat gateway routing
  2) VERTEX_PROJECT_ID + VERTEX_REGION (with gcloud ADC)
                       → Anthropic on Vertex AI (claude-haiku-4-5@20251001)
  3) (none)            → mock LLM (smoke + dry-run)

Auto-loaded files (in order, first match wins):
  .env: ./.env, ./naia-agent.env, ~/.naia-agent/.env
  json: ./.naia-agent.json, ~/.naia-agent/config.json
  process.env always wins; .env/json only fill missing keys.`);
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    chunks.push(chunk);
  }
  return chunks.join("").trim();
}

async function runOnce(agent: Agent, prompt: string): Promise<void> {
  let textStreamed = false;
  let finalText = "";
  for await (const ev of agent.sendStream(prompt)) {
    if (ev.type === "text" && ev.text) {
      // Real LLM streams non-empty text deltas; print as they arrive.
      process.stdout.write(ev.text);
      textStreamed = true;
    } else if (ev.type === "turn.ended") {
      finalText = ev.assistantText;
      // Mock LLMs may not stream deltas; fall back to finalText print.
      if (!textStreamed && finalText) {
        process.stdout.write(finalText);
      }
      process.stdout.write("\n");
    }
  }
}

async function repl(agent: Agent): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log(`naia-agent ${VERSION} REPL — type ":quit" or Ctrl+D to exit.\n`);
  try {
    while (true) {
      let line: string;
      try {
        line = (await ask("naia> ")).trim();
      } catch {
        // Ctrl+D / EOF
        break;
      }
      if (!line) continue;
      if (line === ":quit" || line === ":exit" || line === ":q") break;
      try {
        await runOnce(agent, line);
      } catch (err) {
        console.error(`\n[error] ${(err as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  let cli: CliArgs;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    printHelp();
    return 1;
  }

  if (cli.help) {
    printHelp();
    return 0;
  }
  if (cli.version) {
    console.log(VERSION);
    return 0;
  }

  // Slice 1c: auto-load .env + JSON config, then detect provider env.
  const envReport = loadEnvAndConfig({
    envPath: cli.envPath,
    configPath: cli.configPath,
  });
  if (envReport.envFile || envReport.configFile) {
    process.stderr.write(
      `[naia-agent] loaded ${envReport.envFile ? `.env=${envReport.envFile}` : ""}` +
        `${envReport.envFile && envReport.configFile ? " " : ""}` +
        `${envReport.configFile ? `config=${envReport.configFile}` : ""}` +
        ` (${envReport.loadedKeys.length} keys)\n`,
    );
  }

  const { client: realLLM, mode } = await detectRealLLM();
  process.stderr.write(`[naia-agent] provider: ${mode}\n`);
  const host = createHost({ logLevel: "warn", llm: realLLM });
  const agent = new Agent({
    host,
    systemPrompt: "You are naia-agent, a helpful AI assistant in CLI mode.",
    tierForTool: () => "T0",
  });

  try {
    if (cli.prompt) {
      // args mode
      await runOnce(agent, cli.prompt);
    } else if (!process.stdin.isTTY) {
      // stdin mode
      const input = await readStdin();
      if (!input) {
        console.error("error: empty stdin");
        return 1;
      }
      await runOnce(agent, input);
    } else {
      // REPL mode
      await repl(agent);
    }
    return 0;
  } catch (err) {
    console.error(`\nFAIL: ${(err as Error).message}`);
    return 2;
  } finally {
    agent.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
