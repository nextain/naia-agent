import { readFile, readdir } from "node:fs/promises";
import { validateFixture } from "./dist/fixture.js";
const dir = "./src/fixtures";
const files = (await readdir(dir)).filter(f => f.endsWith(".fixture.json"));
let ok=0, fail=0;
for (const f of files) {
  const raw = await readFile(`${dir}/${f}`, "utf-8");
  try { validateFixture(JSON.parse(raw)); ok++; console.log(`  OK   ${f}`); }
  catch(e) { fail++; console.log(`  FAIL ${f}: ${e.message.slice(0,120)}`); }
}
console.log(`\n${ok}/${ok+fail} pass`);
