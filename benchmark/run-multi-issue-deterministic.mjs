import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateMultiIssueBenchmark } from "../dist/main/domain/multi-issue-benchmark.js";

const corpusPath = fileURLToPath(new URL("./orchestration/multi-issue-deterministic.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
if (corpus.paidCalls !== 0) throw new Error("deterministic benchmark must make zero paid calls");
const evaluation = evaluateMultiIssueBenchmark(corpus.observation);
process.stdout.write(`${JSON.stringify({ benchmarkId: corpus.benchmarkId, paidCalls: corpus.paidCalls, ...evaluation }, null, 2)}\n`);
if (!evaluation.claimAllowed) process.exitCode = 1;
