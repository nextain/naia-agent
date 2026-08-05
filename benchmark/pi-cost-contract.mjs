import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadPiCostContract(argv, defaultContractUrl) {
  const defaultContract = typeof defaultContractUrl === "object" && !(defaultContractUrl instanceof URL)
    ? structuredClone(defaultContractUrl) : JSON.parse(readFileSync(defaultContractUrl, "utf8"));
  const contractPath = optionValue(argv, "--contract");
  const base = contractPath ? loadDerivedContract(defaultContract, resolve(contractPath)) : defaultContract;
  const pinsPath = optionValue(argv, "--pins");
  return pinsPath ? applyPiCostPins(base, resolve(pinsPath)) : base;
}

export function applyPiCostPins(base, pinsPath) {
  const rawPins = readFileSync(pinsPath, "utf8"); const pins = JSON.parse(rawPins);
  const actualPinsDigest = sha256(rawPins);
  const expectedModels = Object.keys(base.receiptAuthority.priceVersionByModel).sort();
  const actualModels = pins.priceVersionByModel && typeof pins.priceVersionByModel === "object"
    ? Object.keys(pins.priceVersionByModel).sort() : [];
  if (pins.schemaVersion !== 1 || pins.benchmarkId !== base.benchmarkId || pins.taskDigest !== base.taskDigest
    || typeof base.receiptAuthority.authentication.pinsDigest !== "string"
    || base.receiptAuthority.authentication.pinsDigest !== actualPinsDigest
    || typeof pins.harnessJournalKeyId !== "string" || !pins.harnessJournalKeyId
    || typeof pins.gitExecutablePath !== "string" || !pins.gitExecutablePath
    || !/^sha256:[0-9a-f]{64}$/u.test(pins.gitExecutableDigest)
    || !sameStrings(actualModels, expectedModels)
    || Object.values(pins.priceVersionByModel).some((value) => typeof value !== "string" || !value)) {
    throw new Error("benchmark pins are not bound to the frozen contract");
  }
  return { ...base, executionAuthority: { ...base.executionAuthority,
    git: { path: pins.gitExecutablePath, digest: pins.gitExecutableDigest, source: "contract-bound-pins" } },
    receiptAuthority: { ...base.receiptAuthority,
      authentication: { ...base.receiptAuthority.authentication, harnessJournalKeyId: pins.harnessJournalKeyId,
        status: "journal_key_pinned" }, priceVersionByModel: pins.priceVersionByModel } };
}

export function derivedPiCostContract(defaultContract, pinsDigest) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(pinsDigest)) throw new Error("pins digest is malformed");
  return { ...defaultContract, receiptAuthority: { ...defaultContract.receiptAuthority,
    authentication: { ...defaultContract.receiptAuthority.authentication, pinsDigest } } };
}

function loadDerivedContract(defaultContract, path) {
  const candidate = JSON.parse(readFileSync(path, "utf8"));
  const normalized = structuredClone(candidate);
  if (!normalized.receiptAuthority?.authentication) throw new Error("derived benchmark contract is malformed");
  normalized.receiptAuthority.authentication.pinsDigest =
    defaultContract.receiptAuthority.authentication.pinsDigest;
  if (!sameJson(normalized, defaultContract)
    || !/^sha256:[0-9a-f]{64}$/u.test(candidate.receiptAuthority.authentication.pinsDigest)) {
    throw new Error("derived benchmark contract may only bind pinsDigest");
  }
  return candidate;
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  if (argv.indexOf(flag, index + 1) >= 0) throw new Error(`${flag} may be supplied only once`);
  return value;
}

function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameJson(left, right) { return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right)); }
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, sortJson(value[key])]));
  return value;
}
