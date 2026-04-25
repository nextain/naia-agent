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
import { createHost } from "@nextain/agent-runtime";

const VERSION = "0.0.1-slice-1a";

interface CliArgs {
  prompt?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false };
  const positional: string[] = [];
  let terminated = false;
  for (const a of argv) {
    if (terminated) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      terminated = true;
    } else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-V") args.version = true;
    else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else positional.push(a);
  }
  if (positional.length > 0) args.prompt = positional.join(" ");
  return args;
}

function printHelp(): void {
  console.log(`naia-agent ${VERSION}

Usage:
  pnpm naia-agent "your prompt"   # args mode (1-shot)
  echo "prompt" | pnpm naia-agent # stdin mode (1-shot)
  pnpm naia-agent                  # REPL mode

Flags:
  -h, --help     show this help
  -V, --version  show version

Slice 1a — mock LLM only. Slice 1b adds real Anthropic / NAIA gateway.`);
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

  // Slice 1a: createHost defaults to MockLLMClient. Slice 1b will detect
  // ANTHROPIC_API_KEY / NAIA_GATEWAY_URL env and inject real client.
  const host = createHost({ logLevel: "warn" });
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
