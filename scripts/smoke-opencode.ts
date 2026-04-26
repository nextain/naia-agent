#!/usr/bin/env node
/**
 * P0-3 fix — smoke:opencode script.
 * Phase 1 Day 2.5 — invokes OpencodeRunAdapter with a real opencode binary
 * and prints all NaiaStreamChunk events to stdout. Used to validate end-to-end
 * adapter behaviour against the real CLI.
 *
 * Usage:
 *   pnpm smoke:opencode "prompt"           # default (free model auto-routed)
 *   pnpm smoke:opencode "prompt" -m model  # specific provider/model
 *   OPENCODE_BIN=/path/opencode pnpm smoke:opencode "prompt"
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeRunAdapter } from "@nextain/agent-adapter-opencode-cli";
import type { SpawnContext, ToolExecutionContext } from "@nextain/agent-types";

const args = process.argv.slice(2);
let prompt = "";
let model: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-m" || a === "--model") {
    model = args[i + 1];
    i++;
  } else if (a !== undefined && !a.startsWith("-")) {
    prompt = a;
  }
}

if (prompt.length === 0) {
  console.error("Usage: pnpm smoke:opencode \"prompt\" [-m provider/model]");
  process.exit(2);
}

const workdir = mkdtempSync(path.join(tmpdir(), "naia-smoke-"));
const ac = new AbortController();
process.on("SIGINT", () => ac.abort("user SIGINT"));

const tc: ToolExecutionContext = { sessionId: "smoke", workingDir: workdir };
const ctx: SpawnContext = { signal: ac.signal, toolContext: tc };

const adapter = new OpencodeRunAdapter({
  ...(model !== undefined && { model }),
  skipPermissions: true,
});

console.log(`[smoke] adapter=${adapter.id} workdir=${workdir} model=${model ?? "(default)"}`);
console.log(`[smoke] prompt=${JSON.stringify(prompt)}`);
console.log("---");

const session = await adapter.spawn({ prompt, workdir }, ctx);

for await (const chunk of session.events()) {
  process.stdout.write(`[${chunk.type}] ${JSON.stringify(chunk).slice(0, 240)}\n`);
}

console.log("---");
console.log(`[smoke] done. workdir=${workdir} (inspect for changes)`);
