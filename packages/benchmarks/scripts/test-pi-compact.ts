import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";
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

  console.log("History turns:", history.length);
  console.log("History chars:", history.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0));

  const llm = createBenchLLMClient();
  const prepare = createPiLLMMessagePrepareCompact({ llm, keepRecentTokens: 100 });

  console.log("Calling pi prepare...");
  const start = Date.now();
  try {
    const result = await prepare(history);
    console.log("Result in", Date.now() - start, "ms");
    console.log("Result messages:", result?.length);
    if (result) {
      for (const m of result) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        console.log(`  ${m.role}: ${text.slice(0, 200)}...`);
      }
    }
    console.log("LLM tokens:", llm.totalInputTokens, "/", llm.totalOutputTokens);
  } catch (e: any) {
    console.error("ERROR after", Date.now() - start, "ms:", e.message);
    console.log("LLM tokens:", llm.totalInputTokens, "/", llm.totalOutputTokens);
  }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
