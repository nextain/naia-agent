import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(source).toContain("captureMixedLiveExecutionEvidence(repositoryRoot)");
    expect(source).toContain("sealMixedIssueTeamLive({ receiptPath: outputPath");
    expect(source).toContain("requireCurrentSourceMatch: true");
    expect(sealer).toContain('execFileSync(process.execPath, [compilerPath, "-p"');
    expect(sealer).toContain("compilerClosure: digestDirectory(dirname(dirname(compilerPath)))");
    expect(sealer).toContain('execFileSync("git", ["diff", "--quiet", "HEAD", "--"]');
    expect(sealer).toContain("execution runtime closure changed before evidence sealing");
    expect(sealer).toContain("coding executable changed during live run");
    expect(source).toContain("executionEvidence.executables.claude.path");
    expect(source).toContain("executionEvidence.executables.opencode.path");
    expect(source).toContain("executionEvidence.executables.codex.path");
    expect(source).toContain("executionEvidence.executables.node.path");
    expect(sealer).toContain("Codex native package closure changed during live run");
    expect(source).toContain("modelEvidenceSource: receipt.modelEvidenceSource");
    expect(sealer).toContain("SQLite event history is inconsistent with the completed run");
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
        sessionId: "provider-session", sessionEvidenceSource: "provider_reported", modelEvidenceSource: "adapter_requested",
        executionId: "execution",
        tokenCountsAvailable: true, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3,
        cost: { state: "unavailable", reason: "not priced" } };
      const snapshotReceipt = { role: "worker", agentProfileId: "claude-explorer", idempotencyKey: "dispatch:explorer:1",
        latencyMs: 1, ...roleReceipt };
      const profile = { kind: "team", maxRepairCycles: 1, requiredCleanCycles: 1, roles: {
        explorer: { agentProfileId: "claude-explorer", agentKind: "claude-code",
          binding: { provider: "claude-code", model: "sonnet" }, filesystemAccess: "read_only" },
      } };
      const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
        : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}` : JSON.stringify(value);
      const profileDigest = createHash("sha256").update(stableJson(profile)).digest("hex");
      const snapshot = { version: 3, dispatchId: "dispatch", fingerprint: "fingerprint", state: "completed",
        profileDigest, cleanCycles: 1, repairCycles: 0, receipts: [snapshotReceipt],
        result: { ok: true, changedFiles: ["result.txt"] } };
      const database = new Database(join(artifactRoot, "team.db"));
      database.exec("CREATE TABLE issue_team_runs(dispatch_id TEXT,version INTEGER,fingerprint TEXT,state TEXT,snapshot_json TEXT);"
        + "CREATE TABLE issue_team_events(dispatch_id TEXT,sequence INTEGER,event_type TEXT,state TEXT);");
      database.prepare("INSERT INTO issue_team_runs VALUES(?,?,?,?,?)").run("dispatch", 3, "fingerprint", "completed", JSON.stringify(snapshot));
      const insertEvent = database.prepare("INSERT INTO issue_team_events VALUES(?,?,?,?)");
      insertEvent.run("dispatch", 1, "team_created", "ready");
      insertEvent.run("dispatch", 2, "role_claimed", "running");
      insertEvent.run("dispatch", 3, "team_completed", "completed");
      database.close();
      const sealerPath = join(repositoryRoot, "benchmark/seal-mixed-issue-team-live.mjs");
      const fakeBin = join(root, "bin"); mkdirSync(fakeBin);
      const fakeCodexPackage = join(root, "node_modules/@openai/codex-linux-test");
      mkdirSync(fakeCodexPackage, { recursive: true }); writeFileSync(join(fakeCodexPackage, "native"), "bound-native-fixture");
      const executableEnvironment: Record<string, string> = {};
      for (const [command, environmentName] of [["claude", "CLAUDE_BIN"], ["opencode", "OPENCODE_BIN"], ["codex", "CODEX_BIN"]]) {
        const path = join(fakeBin, command); writeFileSync(path, `#!/bin/sh\necho ${command}-test-version\n`); chmodSync(path, 0o700);
        executableEnvironment[environmentName] = path;
      }
      const captured = spawnSync(process.execPath,
        [sealerPath, "--capture-execution-evidence", "--repository-root", repositoryRoot],
        { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...executableEnvironment } });
      expect(captured.status, captured.stderr).toBe(0);
      const executionEvidence = JSON.parse(captured.stdout);
      const original = { schemaVersion: 1, benchmarkId: "mixed-issue-team-live-v1", status: "passed",
        paidCalls: 1, maximumPaidCalls: 7, profile,
        result: { ok: true, changedFiles: ["result.txt"], cleanCycles: 1, repairCycles: 0 },
        assertions: { exactArtifacts: true, evidenceComplete: false, mixedAppsObserved: false,
          roleKinds: { explorer: "claude-code" } }, executionEvidence, claimAllowed: true, receipts: [roleReceipt] };
      writeFileSync(receiptPath, JSON.stringify(original));
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      const sealed = spawnSync(process.execPath, [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit], { cwd: repositoryRoot, encoding: "utf8" });
      expect(sealed.status, sealed.stderr).toBe(0);
      const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(parsed).toMatchObject({ artifactRoot: expect.stringContaining("receipt.json.artifacts"),
        assertions: { durableEvidenceEmbedded: true, receiptMatchesDurableSnapshot: true },
        embeddedEvidence: { sourceCommit, durableRun: { state: "completed" } } });
      const tamperedCases = [
        { name: "receipt", mutate: (value: any) => { value.receipts[0].inputTokens = 999; }, message: "receipt projection" },
        { name: "paid calls", mutate: (value: any) => { value.paidCalls = 2; }, message: "receipt summary" },
        { name: "profile", mutate: (value: any) => { value.profile.roles.explorer.binding.model = "other"; }, message: "profile does not match" },
        { name: "result", mutate: (value: any) => { value.result.cleanCycles = 2; }, message: "receipt summary" },
        { name: "assertions", mutate: (value: any) => { value.assertions.exactArtifacts = false; }, message: "receipt summary" },
        { name: "source binding", mutate: (value: any) => { value.executionEvidence.sourceTree = "0".repeat(40); }, message: "execution evidence" },
        { name: "compiler closure", mutate: (value: any) => { value.executionEvidence.runtimeBuild.compilerClosure.manifestSha256 = "0".repeat(64); }, message: "execution evidence" },
        { name: "executable binding", mutate: (value: any) => { value.executionEvidence.executables.codex.sha256 = "0".repeat(64); }, message: "coding executable" },
      ];
      for (const candidate of tamperedCases) {
        const value = structuredClone(original); candidate.mutate(value); writeFileSync(receiptPath, JSON.stringify(value));
        const tampered = spawnSync(process.execPath, [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit], { cwd: repositoryRoot, encoding: "utf8" });
        expect(tampered.status, candidate.name).not.toBe(0);
        expect(tampered.stderr, candidate.name).toContain(candidate.message);
      }
      writeFileSync(receiptPath, JSON.stringify(original));
      const tamperedDatabase = new Database(join(artifactRoot, "team.db"));
      tamperedDatabase.prepare("UPDATE issue_team_events SET state='ready' WHERE sequence=2").run(); tamperedDatabase.close();
      const eventTamper = spawnSync(process.execPath, [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit], { cwd: repositoryRoot, encoding: "utf8" });
      expect(eventTamper.status).not.toBe(0);
      expect(eventTamper.stderr).toContain("SQLite event history is inconsistent");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
