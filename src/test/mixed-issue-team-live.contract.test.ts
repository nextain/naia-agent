import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../benchmark/run-mixed-issue-team-live.mjs", import.meta.url), "utf8");
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("mixed issue-team paid live benchmark contract", () => {
  it("fails closed before paid execution without an explicit bounded confirmation", () => {
    expect(source).toContain('process.argv.includes("--confirm-seven-paid-calls")');
    expect(source).toContain('process.env.NAIA_MIXED_TEAM_LIVE_CONFIRM === "1"');
    expect(source).toContain("if (paidCalls >= 7)");
    expect(source).toContain('return endedSession("mixed live paid-call ceiling reached")');
    expect(source).toContain("roleDeadlineMs: 180_000");
  });

  it("uses three real coding apps with one and only one writing role", () => {
    expect(source).toContain('agentKind: "claude-code"');
    expect(source).toContain('agentKind: "opencode"');
    expect(source).toContain('agentKind: "codex"');
    expect(source.match(/filesystemAccess: "workspace_write"/gu)).toHaveLength(1);
    expect(source).toContain('model: "opencode/deepseek-v4-flash-free"');
    expect(source).toContain('model: "azure-foundry/gpt-5-4-nano"');
  });

  it("requires exact artifacts, complete identities, and all three apps before allowing a claim", () => {
    expect(source).toContain('resultBytes === "NAIA_MIXED_TEAM_OK\\n"');
    expect(source).toContain('seedBytes === "SEED_MUST_STAY\\n"');
    expect(source).toContain("const evidenceComplete = receipts.length >= 4");
    expect(source).toContain('receipt.sessionEvidenceSource === "provider_reported"');
    expect(source).toContain("const mixedAppsObserved = new Set(receipts.map((receipt) => receipt.agentKind)).size === 3");
    expect(source).toContain("claimAllowed: passed");
  });

  it("has a deterministic sealer for tracked source, durable state, and exact fixture evidence", () => {
    const sealer = readFileSync(new URL("../../benchmark/seal-mixed-issue-team-live.mjs", import.meta.url), "utf8");
    expect(sealer).toContain('git", ["show", `${sourceCommit}:benchmark/run-mixed-issue-team-live.mjs`]');
    expect(sealer).toContain("receipt projection does not match the durable SQLite snapshot");
    expect(sealer).toContain("durableEvidenceEmbedded: true");
    expect(sealer).toContain("receiptMatchesDurableSnapshot: true");
  });

  it("seals matching durable evidence and rejects a tampered receipt", () => {
    const workRoot = join(repositoryRoot, ".agents/work"); mkdirSync(workRoot, { recursive: true });
    const root = mkdtempSync(join(workRoot, "mixed-live-sealer-"));
    try {
      const receiptPath = join(root, "receipt.json");
      const artifactRoot = `${receiptPath}.artifacts`; const fixtureRoot = join(artifactRoot, "fixture");
      mkdirSync(fixtureRoot, { recursive: true });
      writeFileSync(join(fixtureRoot, "result.txt"), "NAIA_MIXED_TEAM_OK\n");
      writeFileSync(join(fixtureRoot, "seed.txt"), "SEED_MUST_STAY\n");
      const roleReceipt = { workerRole: "explorer", agentKind: "claude-code", provider: "claude-code", model: "sonnet",
        sessionId: "provider-session", sessionEvidenceSource: "provider_reported", executionId: "execution",
        tokenCountsAvailable: true, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3,
        cost: { state: "unavailable", reason: "not priced" } };
      const snapshotReceipt = { role: "worker", agentProfileId: "claude-explorer", idempotencyKey: "dispatch:explorer:1",
        latencyMs: 1, modelEvidenceSource: "adapter_requested", ...roleReceipt };
      const snapshot = { version: 1, dispatchId: "dispatch", fingerprint: "fingerprint", state: "completed",
        receipts: [snapshotReceipt] };
      const database = new Database(join(artifactRoot, "team.db"));
      database.exec("CREATE TABLE issue_team_runs(dispatch_id TEXT,version INTEGER,fingerprint TEXT,state TEXT,snapshot_json TEXT);"
        + "CREATE TABLE issue_team_events(dispatch_id TEXT,sequence INTEGER,event_type TEXT,state TEXT);");
      database.prepare("INSERT INTO issue_team_runs VALUES(?,?,?,?,?)").run("dispatch", 1, "fingerprint", "completed", JSON.stringify(snapshot));
      database.prepare("INSERT INTO issue_team_events VALUES(?,?,?,?)").run("dispatch", 1, "team_completed", "completed");
      database.close();
      writeFileSync(receiptPath, JSON.stringify({ status: "passed", claimAllowed: true, receipts: [roleReceipt], assertions: {} }));
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      const sealerPath = join(repositoryRoot, "benchmark/seal-mixed-issue-team-live.mjs");
      const sealed = spawnSync(process.execPath, [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit], { cwd: repositoryRoot, encoding: "utf8" });
      expect(sealed.status, sealed.stderr).toBe(0);
      const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(parsed).toMatchObject({ artifactRoot: expect.stringContaining("receipt.json.artifacts"),
        assertions: { durableEvidenceEmbedded: true, receiptMatchesDurableSnapshot: true },
        embeddedEvidence: { sourceCommit, durableRun: { state: "completed" } } });
      parsed.receipts[0].inputTokens = 999; writeFileSync(receiptPath, JSON.stringify(parsed));
      const tampered = spawnSync(process.execPath, [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit], { cwd: repositoryRoot, encoding: "utf8" });
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("receipt projection does not match the durable SQLite snapshot");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
