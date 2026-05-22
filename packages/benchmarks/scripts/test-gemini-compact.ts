import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiLLMMessagePrepareCompact } from "@nextain/agent-runtime";
import { validateFixture } from "../src/fixture.js";
import { createBenchLLMClient } from "../src/bench-llm-client.js";
import type { LLMMessage } from "@nextain/agent-types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "..", "src", "fixtures");

async function main() {
  const raw = await readFile(join(FIX_DIR, "F-LME-s-94f70d80.fixture.json"), "utf-8");
  const fixture = validateFixture(JSON.parse(raw));
  const turns = fixture.turns.slice(0, 280);
  const history: LLMMessage[] = turns.map(t => ({ role: t.role, content: t.content }));

  const histChars = history.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0);
  console.log("History:", history.length, "turns,", histChars, "chars");

  const llm = createBenchLLMClient();
  const prepare = createPiLLMMessagePrepareCompact({ llm, keepRecentTokens: 100 });

  const start = Date.now();
  const result = await prepare(history);
  const elapsed = Date.now() - start;

  console.log("Elapsed:", elapsed, "ms");
  console.log("Result messages:", result?.length ?? "undefined");
  if (result) {
    for (const m of result) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      console.log(`  ${m.role}: ${text.slice(0, 300)}...`);
    }
  }
  console.log("Tokens:", llm.totalInputTokens, "/", llm.totalOutputTokens);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
