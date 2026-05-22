import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";
import { validateFixture } from "../src/fixture.js";
import { runFixture } from "../src/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "..", "src", "fixtures");

async function main() {
  const raw = await readFile(join(FIX_DIR, "F-LME-s-94f70d80.fixture.json"), "utf-8");
  const fixture = validateFixture(JSON.parse(raw));
  for (const s of ["off", "reactive", "pi"] as const) {
    const memPath = join("/tmp", `test-mem-${s}.json`);
    const mem = new MemorySystem({ adapter: new LocalAdapter(memPath), consolidationIntervalMs: 0 });
    const fr = await runFixture(fixture, s, { keepTail: 10, targetTokens: 1000, memorySystem: mem });
    console.log(`${s}: latency=${fr.compactionLatencyMs} inTok=${fr.compactionInputTokens} outTok=${fr.compactionOutputTokens} type_latency=${typeof fr.compactionLatencyMs}`);
    await mem.close();
  }
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
