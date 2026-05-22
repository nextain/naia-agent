import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";
import { validateFixture } from "../src/fixture.js";
import { runFixture } from "../src/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "..", "src", "fixtures");

async function main() {
  const raw = await readFile(join(FIX_DIR, "F-LME-s-bc149d6b.fixture.json"), "utf-8");
  const fixture = validateFixture(JSON.parse(raw));
  const mem = new MemorySystem({ adapter: new LocalAdapter("/tmp/test-reactive-mem.json"), consolidationIntervalMs: 0 });

  const fr = await runFixture(fixture, "reactive", { keepTail: 10, targetTokens: 1000, memorySystem: mem });
  const recap = fr.recapContent ?? "";
  console.log("Recap length:", recap.length, "chars");
  console.log("Recap preview:");
  console.log(recap.slice(0, 2000));
  await mem.close();
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
