#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { derivedPiCostContract } from "./pi-cost-contract.mjs";
import { withoutBenchmarkCredentials } from "./pi-cost-git-isolation.mjs";

const argv = process.argv.slice(2);
const defaultContract = JSON.parse(readFileSync(new URL("./orchestration/pi-cost-comparison.json", import.meta.url), "utf8"));
const pinsOutput = requiredPath(argv, "--output-pins");
const contractOutput = requiredPath(argv, "--output-contract");
if (resolve(pinsOutput) === resolve(contractOutput)) throw new Error("pins and contract outputs must differ");
if (existsSync(pinsOutput) || existsSync(contractOutput)) throw new Error("pins or contract output already exists");
const gitArgument = requiredPath(argv, "--git");
if (!isAbsolute(gitArgument) || !existsSync(gitArgument) || !statSync(gitArgument).isFile()) {
  throw new Error("--git must name an existing absolute executable file");
}
const gitPath = realpathSync(gitArgument);
const gitProbe = spawnSync(gitPath, ["--version"], { encoding: "utf8", env: withoutBenchmarkCredentials(process.env) });
if (gitProbe.status !== 0 || !/^git version \S+/u.test(gitProbe.stdout.trim())) {
  throw new Error("pinned Git executable failed identity probe");
}
const keyEnv = optionalValue(argv, "--journal-key-env") ?? "NAIA_BENCHMARK_JOURNAL_KEY";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(keyEnv)) throw new Error("journal key environment name is invalid");
const journalKey = process.env[keyEnv];
if (typeof journalKey !== "string" || Buffer.byteLength(journalKey, "utf8") < 32) {
  throw new Error(`journal integrity key in ${keyEnv} is unavailable or shorter than 32 bytes`);
}
const prices = parsePriceVersions(argv, Object.keys(defaultContract.receiptAuthority.priceVersionByModel));
const pins = { schemaVersion: 1, benchmarkId: defaultContract.benchmarkId, taskDigest: defaultContract.taskDigest,
  harnessJournalKeyId: sha256(Buffer.from(journalKey, "utf8")), gitExecutablePath: gitPath,
  gitExecutableDigest: sha256(readFileSync(gitPath)), priceVersionByModel: prices };
const pinsBytes = `${JSON.stringify(pins, null, 2)}\n`;
const pinsDigest = sha256(Buffer.from(pinsBytes, "utf8"));
const derivedContract = derivedPiCostContract(defaultContract, pinsDigest);
writeFileSync(pinsOutput, pinsBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
writeFileSync(contractOutput, `${JSON.stringify(derivedContract, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "prepared", paidCalls: 0, gatewayCalls: 0,
  pinsOutput: resolve(pinsOutput), contractOutput: resolve(contractOutput), pinsDigest,
  harnessJournalKeyId: pins.harnessJournalKeyId, gitExecutablePath: gitPath,
  gitExecutableDigest: pins.gitExecutableDigest, priceVersionByModel: prices }, null, 2)}\n`);

function parsePriceVersions(args, models) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--price-version") continue;
    const raw = args[index + 1]; const separator = raw?.indexOf("=") ?? -1;
    if (!raw || separator <= 0 || separator === raw.length - 1) throw new Error("--price-version requires model=id");
    const model = raw.slice(0, separator); const value = raw.slice(separator + 1);
    if (!models.includes(model) || values.has(model)) throw new Error(`unexpected or duplicate price-version model: ${model}`);
    values.set(model, value);
  }
  if (values.size !== models.length) throw new Error(`price versions are required for exactly: ${models.sort().join(", ")}`);
  return Object.fromEntries(models.sort().map((model) => [model, values.get(model)]));
}
function requiredPath(args, flag) {
  const value = optionalValue(args, flag); if (!value) throw new Error(`${flag} is required`); return resolve(value);
}
function optionalValue(args, flag) {
  const index = args.indexOf(flag); if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  if (args.indexOf(flag, index + 1) >= 0) throw new Error(`${flag} may be supplied only once`);
  return value;
}
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
