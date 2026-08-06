import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    expect(source).toContain("artifactBindingPath, executionArtifactRoot, claimAllowed: false");
    expect(source).toContain('if (payload.status === "passed")');
  });

  it("has a deterministic sealer for tracked source, durable state, and exact fixture evidence", () => {
    const sealer = readFileSync(new URL("../../benchmark/seal-mixed-issue-team-live.mjs", import.meta.url), "utf8");
    const evidence = readFileSync(new URL("../../benchmark/mixed-live-execution-evidence.mjs", import.meta.url), "utf8");
    const durable = readFileSync(new URL("../../benchmark/mixed-live-durable-validation.mjs", import.meta.url), "utf8");
    const secureFiles = readFileSync(new URL("../../benchmark/mixed-live-secure-files.mjs", import.meta.url), "utf8");
    expect(evidence).toContain('execFileSync("git", ["show", `${sourceCommit}:${path}`]');
    for (const path of ["mixed-live-durable-validation.mjs", "mixed-live-execution-evidence.mjs",
      "mixed-live-seal-utils.mjs", "mixed-live-secure-files.mjs"]) {
      expect(evidence).toContain(`benchmark/${path}`);
    }
    expect(evidence).toContain("supportModuleSha256: Object.fromEntries");
    expect(evidence).toContain("currentSupportModules");
    expect(evidence).toContain("JSON.stringify(currentSupportModules) !== JSON.stringify(value.supportModuleSha256)");
    expect(sealer).toContain("receipt projection does not match the durable SQLite snapshot");
    expect(sealer).toContain("durableEvidenceEmbedded: true");
    expect(sealer).toContain("selfContainedEvidenceEmbedded: true");
    expect(sealer).toContain("externalArtifactsExcludedFromClaim: true");
    expect(sealer).toContain('sqliteHex: databaseBytes.toString("hex")');
    expect(source).toContain("captureMixedLiveExecutionEvidence(repositoryRoot)");
    expect(source).toContain("validateLiveExecutionInputs(executionEvidence, repositoryRoot)");
    expect(source).toContain("boundReceiptFd: receiptFd");
    expect(source).toContain('executionRuntimeIdentity: "path_hash_observed_at_boundaries_not_execution_pinned"');
    expect(source).toContain("sealMixedIssueTeamLive({ receiptPath: outputPath");
    expect(source).toContain("requireCurrentSourceMatch: true");
    expect(evidence).toContain('execFileSync(process.execPath, [compilerPath, "-p"');
    expect(evidence).toContain("compilerClosure: digestDirectory(dirname(dirname(compilerPath)))");
    expect(evidence).toContain("sqliteClosure: captureSqliteClosure()");
    expect(evidence).toContain('{ excludePrefixes: ["node_modules/.bin"] }');
    expect(evidence).toContain('sqliteRequire.resolve("bindings/package.json")');
    expect(evidence).toContain('sqliteRequire.resolve("file-uri-to-path/package.json")');
    expect(source).toContain("const runId = randomUUID()");
    expect(source).toContain('modelIdentity: "adapter_requested_not_provider_observed"');
    expect(source).toContain('providerIdentity: "adapter_declared_not_provider_observed"');
    expect(source).toContain('verificationPortability: "same_linux_host_clean_checkout_with_locked_dependencies_and_exact_bound_external_toolchain"');
    expect(source).toContain('claimEvidence: "atomically_published_self_contained_receipt_evidence"');
    expect(source).toContain('externalArtifacts: "non_authoritative_working_copy_excluded_from_claim_after_capture"');
    expect(sealer).toContain("artifact binding does not match its execution path");
    expect(evidence).toContain('execFileSync("git", ["diff", "--quiet", "HEAD", "--"]');
    expect(evidence).toContain("current benchmark source or execution runtime closure does not match the live run");
    expect(sealer).toContain("requireCurrentSourceMatch: true,");
    expect(sealer).toContain("verifyExistingSeal: verifySealed");
    expect(evidence).toContain("coding executable changed during live run");
    expect(source).toContain("executionEvidence.executables.claude.path");
    expect(source).toContain("executionEvidence.executables.opencode.path");
    expect(source).toContain("executionEvidence.executables.codex.path");
    expect(source).toContain("executionEvidence.executables.node.path");
    expect(evidence).toContain("Codex native package closure changed during live run");
    expect(source).toContain("modelEvidenceSource: receipt.modelEvidenceSource");
    expect(durable).toContain("SQLite event history is inconsistent with the completed run");
    expect(secureFiles).toContain("fixture evidence changed before the sealing commit point");
    expect(secureFiles).toContain("publishJsonAtomically");
    expect(secureFiles).toContain("fsyncArtifactEvidence");
    expect(secureFiles).toContain("afterRenameBeforeDirectorySync");
    expect(secureFiles).toContain("unsealed-backup-");
    expect(secureFiles).toContain("renameSync(`/proc/self/fd/${parentFd}/${temporaryName}`");
  });

  it("seals matching durable evidence and rejects a tampered receipt", () => {
    const root = mkdtempSync(join(repositoryRoot, "benchmark/.tmp-mixed-live-sealer-"));
    const executableEnvironmentNames = ["CLAUDE_BIN", "OPENCODE_BIN", "CODEX_BIN"] as const;
    const previousExecutableEnvironment = Object.fromEntries(
      executableEnvironmentNames.map((name) => [name, process.env[name]]),
    );
    try {
      const receiptPath = join(root, "receipt.json");
      const artifactRoot = `${receiptPath}.artifacts`; const fixtureRoot = join(artifactRoot, "fixture");
      mkdirSync(fixtureRoot, { recursive: true });
      const runId = "12345678-1234-4123-8123-123456789abc"; const dispatchId = `${runId}:dispatch:1`;
      const executionArtifactRoot = realpathSync(artifactRoot);
      const artifactBindingPath = relative(repositoryRoot, artifactRoot).split("\\").join("/");
      const runBinding = createHash("sha256").update(`${runId}\0${artifactBindingPath}`).digest("hex");
      writeFileSync(join(fixtureRoot, "result.txt"), "NAIA_MIXED_TEAM_OK\n");
      writeFileSync(join(fixtureRoot, "seed.txt"), "SEED_MUST_STAY\n");
      const profile = { kind: "team", maxRepairCycles: 1, requiredCleanCycles: 1, roles: {
        explorer: { agentProfileId: "claude-explorer", agentKind: "claude-code",
          binding: { provider: "claude-code", model: "sonnet" }, filesystemAccess: "read_only" },
        implementer: { agentProfileId: "opencode-implementer", agentKind: "opencode",
          binding: { provider: "opencode", model: "opencode/deepseek-v4-flash-free" }, filesystemAccess: "workspace_write" },
        tester: { agentProfileId: "codex-tester", agentKind: "codex",
          binding: { provider: "openai-codex", model: "gpt-5.3-codex-spark", reasoningEffort: "low" }, filesystemAccess: "read_only" },
        reviewer: { agentProfileId: "codex-reviewer", agentKind: "codex",
          binding: { provider: "openai-codex", model: "gpt-5.3-codex-spark", reasoningEffort: "low" }, filesystemAccess: "read_only" },
      } };
      const roleOrder = ["explorer", "implementer", "tester", "reviewer", "implementer", "tester", "reviewer"] as const;
      const receipts = roleOrder.map((workerRole, index) => { const role = profile.roles[workerRole]; return { workerRole,
        agentKind: role.agentKind, provider: role.binding.provider, model: role.binding.model,
        ...("reasoningEffort" in role.binding ? { reasoningEffort: role.binding.reasoningEffort } : {}),
        sessionId: `provider-session-${index}`, sessionEvidenceSource: "provider_reported",
        modelEvidenceSource: "adapter_requested", executionId: `execution-${index}`,
        tokenCountsAvailable: true, inputTokens: index + 1, cachedInputTokens: index + 2, outputTokens: index + 3,
        cost: { state: "unavailable", reason: "not priced" } }; });
      const snapshotReceipts = receipts.map((receipt, index) => ({ role: "worker",
        agentProfileId: profile.roles[receipt.workerRole as keyof typeof profile.roles].agentProfileId,
        idempotencyKey: `${dispatchId}:${receipt.workerRole}:${index + 1}`, latencyMs: 1, ...receipt }));
      const decisions = ["proceed", "implemented", "pass", "changes_requested", "implemented", "pass", "clean"] as const;
      const outcomes = roleOrder.map((role, index) => ({ version: 1, role, decision: decisions[index],
        summary: `${role} fixture outcome`, findings: [] }));
      const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
        : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}` : JSON.stringify(value);
      const profileDigest = createHash("sha256").update(stableJson(profile)).digest("hex");
      const snapshot = { version: 15, dispatchId, issueId: runBinding, fingerprint: "fingerprint", state: "completed",
        profileDigest, cleanCycles: 1, repairCycles: 1, receipts: snapshotReceipts,
        outcomes,
        allocation: { workspacePath: join(executionArtifactRoot, "fixture"),
          worktreePath: join(executionArtifactRoot, "fixture") },
        result: { ok: true, changedFiles: ["result.txt"] } };
      const database = new Database(join(artifactRoot, "team.db"));
      database.exec("CREATE TABLE issue_team_runs(dispatch_id TEXT,version INTEGER,fingerprint TEXT,state TEXT,snapshot_json TEXT);"
        + "CREATE TABLE issue_team_events(dispatch_id TEXT,sequence INTEGER,event_type TEXT,state TEXT);");
      database.prepare("INSERT INTO issue_team_runs VALUES(?,?,?,?,?)").run(dispatchId, 15, "fingerprint", "completed", JSON.stringify(snapshot));
      const insertEvent = database.prepare("INSERT INTO issue_team_events VALUES(?,?,?,?)");
      for (let sequence = 1; sequence <= 15; sequence += 1) {
        insertEvent.run(dispatchId, sequence, sequence === 1 ? "team_created" : sequence === 15 ? "team_completed"
          : sequence % 2 === 0 ? "role_claimed" : "role_acknowledged",
        sequence === 15 ? "completed" : sequence % 2 === 0 ? "running" : "ready");
      }
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
      Object.assign(process.env, executableEnvironment);
      const captured = spawnSync(process.execPath,
        [sealerPath, "--capture-execution-evidence", "--repository-root", repositoryRoot],
        { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...executableEnvironment } });
      expect(captured.status, captured.stderr).toBe(0);
      const executionEvidence = JSON.parse(captured.stdout);
      const original = { schemaVersion: 1, benchmarkId: "mixed-issue-team-live-v1", status: "passed", runId,
        paidCalls: 7, maximumPaidCalls: 7, profile, claimScope: { sessionIdentity: "provider_reported",
          providerIdentity: "adapter_declared_not_provider_observed",
          modelIdentity: "adapter_requested_not_provider_observed",
          executionRuntimeIdentity: "path_hash_observed_at_boundaries_not_execution_pinned",
          capability: "mixed_adapter_execution",
          verificationPortability: "same_linux_host_clean_checkout_with_locked_dependencies_and_exact_bound_external_toolchain",
          claimEvidence: "atomically_published_self_contained_receipt_evidence",
          externalArtifacts: "non_authoritative_working_copy_excluded_from_claim_after_capture" },
        result: { ok: true, changedFiles: ["result.txt"], cleanCycles: 1, repairCycles: 1 },
        assertions: { exactArtifacts: true, evidenceComplete: true, mixedAppsObserved: true,
          roleKinds: { explorer: "claude-code", implementer: "opencode", tester: "codex", reviewer: "codex" } },
        executionEvidence, claimAllowed: false, receipts };
      Object.assign(original, { artifactBindingPath, executionArtifactRoot });
      writeFileSync(receiptPath, JSON.stringify(original));
      const decoyClaude = join(fakeBin, "claude-decoy");
      cpSync(executableEnvironment.CLAUDE_BIN, decoyClaude); chmodSync(decoyClaude, 0o700);
      const retargeted = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit",
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
          "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8",
          env: { ...process.env, ...executableEnvironment, CLAUDE_BIN: decoyClaude } });
      expect(retargeted.status).not.toBe(0);
      expect(retargeted.stderr).toContain("coding executable resolved path changed: claude");
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      const raced = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { writeFileSync } from "node:fs";
         const { sealMixedIssueTeamLive } = await import(${JSON.stringify(pathToFileURL(sealerPath).href)});
         sealMixedIssueTeamLive({ receiptPath: ${JSON.stringify(receiptPath)}, sourceCommit: ${JSON.stringify(sourceCommit)},
           requireCurrentSourceMatch: true,
           beforeFinalEvidenceCheck: () => writeFileSync(${JSON.stringify(join(fixtureRoot, "result.txt"))}, "RACED\\n") });`],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...executableEnvironment } });
      expect(raced.status).not.toBe(0);
      expect(raced.stderr).toContain("fixture evidence changed before the sealing commit point");
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ claimAllowed: false });
      writeFileSync(join(fixtureRoot, "result.txt"), "NAIA_MIXED_TEAM_OK\n");
      const receiptRaced = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { writeFileSync } from "node:fs";
         const { sealMixedIssueTeamLive } = await import(${JSON.stringify(pathToFileURL(sealerPath).href)});
         sealMixedIssueTeamLive({ receiptPath: ${JSON.stringify(receiptPath)}, sourceCommit: ${JSON.stringify(sourceCommit)},
           requireCurrentSourceMatch: true,
           beforeFinalEvidenceCheck: () => writeFileSync(${JSON.stringify(receiptPath)}, ${JSON.stringify("RACED\n")}) });`],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...executableEnvironment } });
      expect(receiptRaced.status).not.toBe(0);
      expect(receiptRaced.stderr).toContain("receipt changed before atomic publication");
      writeFileSync(receiptPath, JSON.stringify(original));
      const publicationSyncFailed = spawnSync(process.execPath, ["--input-type=module", "-e",
        `const { sealMixedIssueTeamLive } = await import(${JSON.stringify(pathToFileURL(sealerPath).href)});
         sealMixedIssueTeamLive({ receiptPath: ${JSON.stringify(receiptPath)}, sourceCommit: ${JSON.stringify(sourceCommit)},
           requireCurrentSourceMatch: true,
           afterPublicationRenameBeforeDirectorySync: () => { throw new Error("injected post-rename sync failure"); } });`],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...executableEnvironment } });
      expect(publicationSyncFailed.status).not.toBe(0);
      expect(publicationSyncFailed.stderr).toContain("injected post-rename sync failure");
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ claimAllowed: false });
      expect(readFileSync(receiptPath, "utf8")).not.toContain("selfContainedEvidenceEmbedded");
      expect(readdirSync(root).filter((name) => name.includes("unsealed-backup-") || name.includes(".seal-"))).toEqual([]);
      writeFileSync(receiptPath, JSON.stringify(original));
      const externalRaceAfterGuard = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { writeFileSync } from "node:fs";
         const { sealMixedIssueTeamLive } = await import(${JSON.stringify(pathToFileURL(sealerPath).href)});
         sealMixedIssueTeamLive({ receiptPath: ${JSON.stringify(receiptPath)}, sourceCommit: ${JSON.stringify(sourceCommit)},
           requireCurrentSourceMatch: true,
           afterPublicationEvidenceGuardBeforeReceiptValidation: () => writeFileSync(${JSON.stringify(join(fixtureRoot, "result.txt"))}, "RACED_AFTER_CAPTURE\\n") });`],
      { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, ...executableEnvironment } });
      expect(externalRaceAfterGuard.status, externalRaceAfterGuard.stderr).toBe(0);
      const isolatedClaim = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(isolatedClaim).toMatchObject({ claimAllowed: true, assertions: {
        selfContainedEvidenceEmbedded: true, externalArtifactsExcludedFromClaim: true },
      embeddedEvidence: { fixture: [{ hex: Buffer.from("NAIA_MIXED_TEAM_OK\n").toString("hex") }, expect.anything()],
        sqliteHex: expect.any(String) } });
      expect(createHash("sha256").update(Buffer.from(isolatedClaim.embeddedEvidence.sqliteHex, "hex")).digest("hex"))
        .toBe(isolatedClaim.embeddedEvidence.sqliteSha256);
      writeFileSync(join(fixtureRoot, "result.txt"), "NAIA_MIXED_TEAM_OK\n");
      writeFileSync(receiptPath, JSON.stringify(original));
      const sealed = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(sealed.status, sealed.stderr).toBe(0);
      const parsed = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(parsed).toMatchObject({ artifactRoot: expect.stringContaining("receipt.json.artifacts"),
        assertions: { durableEvidenceEmbedded: true, selfContainedEvidenceEmbedded: true,
          externalArtifactsExcludedFromClaim: true },
        embeddedEvidence: { sourceCommit, durableRun: { state: "completed" } } });
      const embeddedTamper = structuredClone(parsed); embeddedTamper.embeddedEvidence.fixture[0].hex = "00";
      writeFileSync(receiptPath, JSON.stringify(embeddedTamper));
      const embeddedTampered = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--verify-sealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(embeddedTampered.status).not.toBe(0);
      expect(embeddedTampered.stderr).toContain("sealed receipt evidence does not match");
      writeFileSync(receiptPath, JSON.stringify(parsed));
      const replayPath = join(root, "replayed.json");
      cpSync(artifactRoot, `${replayPath}.artifacts`, { recursive: true });
      const replayValue = structuredClone(parsed);
      replayValue.artifactBindingPath = relative(repositoryRoot, `${replayPath}.artifacts`).split("\\").join("/");
      writeFileSync(replayPath, JSON.stringify(replayValue));
      const replayed = spawnSync(process.execPath,
        [sealerPath, "--receipt", replayPath, "--source-commit", sourceCommit, "--verify-sealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(replayed.status).not.toBe(0);
      expect(replayed.stderr).toContain("durable run binding does not match");
      const tamperedCases = [
        { name: "receipt", mutate: (value: any) => { value.receipts[0].inputTokens = 999; }, message: "receipt projection" },
        { name: "paid calls", mutate: (value: any) => { value.paidCalls = 2; }, message: "receipt summary" },
        { name: "profile", mutate: (value: any) => { value.profile.roles.explorer.binding.model = "other"; }, message: "profile does not match" },
        { name: "result", mutate: (value: any) => { value.result.cleanCycles = 2; }, message: "receipt summary" },
        { name: "assertions", mutate: (value: any) => { value.assertions.exactArtifacts = false; }, message: "receipt summary" },
        { name: "source binding", mutate: (value: any) => { value.executionEvidence.sourceTree = "0".repeat(40); }, message: "execution evidence" },
        { name: "compiler closure", mutate: (value: any) => { value.executionEvidence.runtimeBuild.compilerClosure.manifestSha256 = "0".repeat(64); }, message: "execution evidence" },
        { name: "support module binding", mutate: (value: any) => {
          value.executionEvidence.supportModuleSha256["benchmark/mixed-live-secure-files.mjs"] = "0".repeat(64);
        }, message: "execution evidence" },
        { name: "executable binding", mutate: (value: any) => { value.executionEvidence.executables.codex.sha256 = "0".repeat(64); }, message: "coding executable" },
      ];
      for (const candidate of tamperedCases) {
        const value = structuredClone(original); candidate.mutate(value); writeFileSync(receiptPath, JSON.stringify(value));
        const tampered = spawnSync(process.execPath,
          [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
          { cwd: repositoryRoot, encoding: "utf8" });
        expect(tampered.status, candidate.name).not.toBe(0);
        expect(tampered.stderr, candidate.name).toContain(candidate.message);
      }
      const resultPath = join(fixtureRoot, "result.txt"); const symlinkTarget = join(artifactRoot, "same-result.txt");
      writeFileSync(symlinkTarget, "NAIA_MIXED_TEAM_OK\n"); rmSync(resultPath);
      symlinkSync(symlinkTarget, resultPath); writeFileSync(receiptPath, JSON.stringify(original));
      const symlinkedArtifact = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(symlinkedArtifact.status).not.toBe(0);
      expect(symlinkedArtifact.stderr).toContain("evidence path contains a symbolic link");
      rmSync(resultPath); writeFileSync(resultPath, "NAIA_MIXED_TEAM_OK\n"); rmSync(symlinkTarget);
      writeFileSync(receiptPath, JSON.stringify(original));
      writeFileSync(join(artifactRoot, "team.db-wal"), "uncheckpointed");
      const uncheckpointed = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(uncheckpointed.status).not.toBe(0);
      expect(uncheckpointed.stderr).toContain("WAL must be checkpointed and empty");
      rmSync(join(artifactRoot, "team.db-wal"));
      const falseSnapshot = structuredClone(snapshot); falseSnapshot.result.ok = false;
      const falsePassDatabase = new Database(join(artifactRoot, "team.db"));
      falsePassDatabase.prepare("UPDATE issue_team_runs SET snapshot_json=?").run(JSON.stringify(falseSnapshot));
      falsePassDatabase.close();
      const falsePassReceipt = structuredClone(original); falsePassReceipt.result.ok = false;
      writeFileSync(receiptPath, JSON.stringify(falsePassReceipt));
      const falsePass = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(falsePass.status).not.toBe(0);
      expect(falsePass.stderr).toContain("receipt summary does not match");
      const restoredDatabase = new Database(join(artifactRoot, "team.db"));
      restoredDatabase.prepare("UPDATE issue_team_runs SET snapshot_json=?").run(JSON.stringify(snapshot));
      restoredDatabase.close();
      writeFileSync(receiptPath, JSON.stringify(original));
      const outcomeSnapshot = structuredClone(snapshot); outcomeSnapshot.outcomes[3].decision = "clean";
      const outcomeDatabase = new Database(join(artifactRoot, "team.db"));
      outcomeDatabase.prepare("UPDATE issue_team_runs SET snapshot_json=?").run(JSON.stringify(outcomeSnapshot));
      outcomeDatabase.close();
      const outcomeTamper = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(outcomeTamper.status).not.toBe(0);
      expect(outcomeTamper.stderr).toContain("receipt summary does not match");
      const outcomeRestore = new Database(join(artifactRoot, "team.db"));
      outcomeRestore.prepare("UPDATE issue_team_runs SET snapshot_json=?").run(JSON.stringify(snapshot));
      outcomeRestore.close();
      const coordinatedCases = [
        { name: "agent profile", message: "durable worker receipt invariants",
          mutateSnapshot: (value: any) => { value.receipts[0].agentProfileId = "wrong-profile"; },
          mutateReceipt: (_value: any) => {} },
        { name: "duplicate identities", message: "durable worker receipt invariants",
          mutateSnapshot: (value: any) => { value.receipts[1].sessionId = value.receipts[0].sessionId; },
          mutateReceipt: (value: any) => { value.receipts[1].sessionId = value.receipts[0].sessionId; } },
        { name: "outcome schema", message: "durable outcome schema",
          mutateSnapshot: (value: any) => { value.outcomes[0].unexpected = true; },
          mutateReceipt: (_value: any) => {} },
      ];
      for (const candidate of coordinatedCases) {
        const changedSnapshot = structuredClone(snapshot); candidate.mutateSnapshot(changedSnapshot);
        const changedReceipt = structuredClone(original); candidate.mutateReceipt(changedReceipt);
        const coordinatedDatabase = new Database(join(artifactRoot, "team.db"));
        coordinatedDatabase.prepare("UPDATE issue_team_runs SET snapshot_json=?").run(JSON.stringify(changedSnapshot));
        coordinatedDatabase.close(); writeFileSync(receiptPath, JSON.stringify(changedReceipt));
        const coordinated = spawnSync(process.execPath,
          [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
          { cwd: repositoryRoot, encoding: "utf8" });
        expect(coordinated.status, candidate.name).not.toBe(0);
        expect(coordinated.stderr, candidate.name).toContain(candidate.message);
        const restore = new Database(join(artifactRoot, "team.db"));
        restore.prepare("UPDATE issue_team_runs SET snapshot_json=?").run(JSON.stringify(snapshot)); restore.close();
      }
      writeFileSync(receiptPath, JSON.stringify(original));
      const tamperedDatabase = new Database(join(artifactRoot, "team.db"));
      tamperedDatabase.prepare("UPDATE issue_team_events SET state='ready' WHERE sequence=2").run(); tamperedDatabase.close();
      const eventTamper = spawnSync(process.execPath,
        [sealerPath, "--receipt", receiptPath, "--source-commit", sourceCommit, "--seal-unsealed"],
        { cwd: repositoryRoot, encoding: "utf8" });
      expect(eventTamper.status).not.toBe(0);
      expect(eventTamper.stderr).toContain("SQLite event history is inconsistent");
    } finally {
      for (const name of executableEnvironmentNames) {
        const previous = previousExecutableEnvironment[name];
        if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
