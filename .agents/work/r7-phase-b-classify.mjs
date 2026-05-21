// R7 Phase B verify: 모든 fixture 의 task-accuracy probe stress 분류 검증.
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { classifyProbeStress, validateFixture } from "../../packages/benchmarks/dist/fixture.js";

const fixtures = [
  "F-KR-IE-01-information-extraction",
  "F-KR-MS-01-multi-session",
  "F-KR-TR-01-temporal-reasoning",
  "F-KR-KU-01-knowledge-update",
  "F-KR-AB-01-abstention",
  "F-EN-TH-01-tool-heavy",
];

const keepTail = 2;
const FIXTURES_DIR = "/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/packages/benchmarks/src/fixtures";

console.log("Fixture | probe afterTurn | compactionPt | factTurns | stress class");
console.log("---|---|---|---|---");

for (const fxid of fixtures) {
  const raw = await readFile(`${FIXTURES_DIR}/${fxid}.fixture.json`, "utf-8");
  const fx = validateFixture(JSON.parse(raw));
  const cp = fx.compactionPoints?.[0];
  for (const probe of fx.probes) {
    if (probe.type !== "task-accuracy") continue;
    const ft = probe.factTurns ?? [];
    const stress = classifyProbeStress(ft, cp, keepTail);
    console.log(`${fxid} | ${probe.afterTurn} | ${cp ?? "n/a"} | [${ft.join(",")}] | **${stress}**`);
  }
}
