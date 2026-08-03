#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { loadCredentialIntoProcess } from "./naia-agent-runtime.mjs";

const HELP = `naia-agent loop — durable Pi-only coding-session manager

Usage:
  naia-agent loop serve  --config <json>
  naia-agent loop start  --config <json> --request <json>
  naia-agent loop list   --config <json>
  naia-agent loop show   --config <json> --session <id>
  naia-agent loop answer --config <json> --session <id> --question <id> --text <answer>
  naia-agent loop cancel --config <json> --session <id>
  naia-agent loop pump   --config <json>
  naia-agent loop budget --config <json>
  naia-agent loop reservations --config <json>

serve keeps one foreground Naia Agent control session alive. It accepts one JSON object per stdin
line with {id, command, ...arguments} and emits one {id, ok, result|error} JSON object per line.
The config pins state/workspace/worktree roots, Pi model bindings, checks, concurrency,
and durable USD/token/call limits. Discord and OpenCode are not used by this command.
`;

class CliUsageError extends Error { constructor(message, code = 64) { super(message); this.code = code; } }

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
} else {
  let loop;
  try {
    const command = args[0];
    const configPath = option(args, "--config");
    if (!configPath) throw new CliUsageError("--config is required");
    const config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
    if (["serve", "start", "answer", "cancel", "pump"].includes(command)) loadCredentialIntoProcess("naia");
    const { makePiContinuousLoop } = await import(new URL("../dist/main/composition/pi-continuous-loop.js", import.meta.url).href);
    loop = makePiContinuousLoop(config);
    if (command === "serve") {
      const { runPiLoopControlSession } = await import(new URL("../dist/main/composition/pi-continuous-loop-control.js", import.meta.url).href);
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      await runPiLoopControlSession(loop, config, input,
        (response) => process.stdout.write(`${JSON.stringify(response)}\n`));
    }
    else process.stdout.write(`${JSON.stringify(await dispatchOneShot(loop, config, command, args), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`naia-agent loop: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CliUsageError ? error.code : 1;
  } finally {
    loop?.close();
  }
}

async function dispatchOneShot(loop, config, command, argv) {
  const get = (name) => option(argv, name);
  if (command === "start") {
    const requestPath = required(get, "--request");
    const session = await submit(loop, config, JSON.parse(readFileSync(resolve(requestPath), "utf8")));
    await loop.sessions.pump();
    return loop.sessions.get(session.sessionId);
  }
  if (command === "list") return loop.sessions.portfolio();
  if (command === "show") return loop.sessions.get(required(get, "--session"));
  if (command === "answer") {
    const session = await loop.sessions.answer(required(get, "--session"), required(get, "--question"), required(get, "--text"));
    await loop.sessions.pump(); return loop.sessions.get(session.sessionId);
  }
  if (command === "cancel") {
    const session = await loop.sessions.cancel(required(get, "--session"));
    await loop.sessions.pump(); return loop.sessions.get(session.sessionId);
  }
  if (command === "pump") { await loop.sessions.pump(); return loop.sessions.portfolio(); }
  if (command === "budget") return loop.budget.snapshot();
  if (command === "reservations") return loop.budget.reservations();
  throw new CliUsageError(`unknown loop command: ${command}`);
}

function submit(loop, config, source) {
  if (!source || typeof source !== "object") throw new CliUsageError("request must be an object");
  const request = { requestId: source.requestId ?? randomUUID(), text: source.text,
    requiredObligations: source.requiredObligations, workspacePath: source.workspacePath,
    naiaBinding: config.facing, moderatorBinding: config.moderator,
    workerProfiles: { [config.profileId]: loop.profile } };
  return loop.sessions.submit({ request, source: { kind: "local", sourceId: source.sourceId ?? request.requestId,
    actorId: source.actorId ?? "local-user" } });
}

function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
function required(get, name) { const found = get(name); if (!found) throw new CliUsageError(`${name} is required`); return found; }
