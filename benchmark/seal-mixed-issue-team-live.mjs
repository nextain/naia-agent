#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const receiptIndex = process.argv.indexOf("--receipt");
const sourceIndex = process.argv.indexOf("--source-commit");
const receiptPath = receiptIndex >= 0 ? resolve(process.argv[receiptIndex + 1] ?? "") : undefined;
const sourceCommit = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
if (!receiptPath || !sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error("usage: seal-mixed-issue-team-live.mjs --receipt <path> --source-commit <40-hex commit>");
}

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(receiptPath), encoding: "utf8",
}).trim();
execFileSync("git", ["cat-file", "-e", `${sourceCommit}^{commit}`], { cwd: repositoryRoot });

const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
if (receipt.status !== "passed" || receipt.claimAllowed !== true || !Array.isArray(receipt.receipts)) {
  throw new Error("only a passed, claim-allowed mixed-team receipt can be sealed");
}
const artifactRoot = `${receiptPath}.artifacts`;
const databasePath = join(artifactRoot, "team.db");
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const run = database.prepare("SELECT dispatch_id,version,fingerprint,state,snapshot_json FROM issue_team_runs").all();
const events = database.prepare("SELECT dispatch_id,sequence,event_type,state FROM issue_team_events ORDER BY dispatch_id,sequence").all();
database.close();
if (run.length !== 1) throw new Error("live evidence must contain exactly one durable team run");
const snapshot = JSON.parse(String(run[0].snapshot_json));
const projected = snapshot.receipts.map(projectReceipt);
if (JSON.stringify(projected) !== JSON.stringify(receipt.receipts)) {
  throw new Error("receipt projection does not match the durable SQLite snapshot");
}

const fixtureRoot = join(artifactRoot, "fixture");
const fixture = readdirSync(fixtureRoot).sort().map((name) => {
  const bytes = readFileSync(join(fixtureRoot, name));
  return { path: name, byteLength: bytes.length, sha256: sha256(bytes), hex: bytes.toString("hex") };
});
if (JSON.stringify(fixture.map(({ path }) => path)) !== JSON.stringify(["result.txt", "seed.txt"])
  || fixture[0].hex !== Buffer.from("NAIA_MIXED_TEAM_OK\n").toString("hex")
  || fixture[1].hex !== Buffer.from("SEED_MUST_STAY\n").toString("hex")) {
  throw new Error("fixture bytes do not match the live benchmark contract");
}

const normalizedSnapshot = JSON.parse(JSON.stringify(snapshot).split(artifactRoot).join("$ARTIFACT_ROOT"));
const durableRun = {
  dispatchId: run[0].dispatch_id,
  version: run[0].version,
  fingerprint: run[0].fingerprint,
  state: run[0].state,
  normalizedSnapshot,
};
receipt.artifactRoot = relative(repositoryRoot, artifactRoot).split("\\").join("/");
receipt.embeddedEvidence = {
  sourceCommit,
  sealerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  benchmarkScriptAtSourceSha256: sha256(execFileSync("git", ["show", `${sourceCommit}:benchmark/run-mixed-issue-team-live.mjs`], { cwd: repositoryRoot })),
  sqliteSha256: sha256(readFileSync(databasePath)),
  durableRun,
  durableRunSha256: sha256(Buffer.from(JSON.stringify(durableRun))),
  events,
  fixture,
};
receipt.assertions = { ...receipt.assertions, durableEvidenceEmbedded: true, receiptMatchesDurableSnapshot: true };
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

function projectReceipt(value) {
  return {
    workerRole: value.workerRole,
    agentKind: value.agentKind,
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    sessionId: value.sessionId,
    sessionEvidenceSource: value.sessionEvidenceSource,
    executionId: value.executionId,
    tokenCountsAvailable: value.tokenCountsAvailable,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    cost: value.cost,
  };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
