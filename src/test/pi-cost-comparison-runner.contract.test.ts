import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { attestPiCostEvidence, piCostIntegrityKeyId } from "../main/adapters/pi-cost-attestation.js";

const root = process.cwd();
const runnerPath = join(root, "benchmark/run-pi-cost-comparison-live.mjs");
const contractPath = join(root, "benchmark/orchestration/pi-cost-comparison.json");
const fixturePath = join(root, "benchmark/fixtures/pi-cost-comparison/base");
const digestRunnerPath = join(root, "benchmark/digest-tree.mjs");

describe("Pi live cost-comparison runner", () => {
  it("pins the exact frozen fixture and task before any paid arm", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const taskDigest = `sha256:${createHash("sha256").update(JSON.stringify(contract.task)).digest("hex")}`;
    expect(contract.schemaVersion).toBe(2);
    expect(contract.taskDigest).toBe(taskDigest);
    expect(contract.baselineDigest).toBe(digestTree(fixturePath));
    expect(contract.minimumSavingsBasisPoints).toBe(1000);
    expect(contract.budget.maximumCombinedUsdDecimal).toBe("0.50000000");
    expect(contract.routePolicy.candidate.roleModels).toMatchObject({ facing: "deepseek-v4-flash",
      implementer: "grok-4.3", reviewer: "deepseek-v4-flash" });
    expect(contract.trustedRuntimeClosure.fileCount).toBeGreaterThan(contract.trustedRuntimeModules.length);
    expect(contract.trustedRuntimeClosure.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(contract.trustedExternalExecutables).toEqual(["git"]);
    expect(contract.executionAuthority.git).toMatchObject({ path: null, digest: null, source: "contract-bound-pins" });
    expect(contract.trustedRuntimeArtifacts).toEqual(expect.arrayContaining([
      "benchmark/run-pi-cost-comparison-live.mjs", "benchmark/analyze-pi-cost-comparison.mjs",
      "benchmark/pi-cost-runtime-trust.mjs", "benchmark/pi-cost-git-isolation.mjs",
      "benchmark/digest-tree.mjs", "scripts/pi/naia-versioned-billing-extension.mjs",
      "scripts/pi/workspace-tool-boundary.mjs", "package.json", "pnpm-lock.yaml",
    ]));
    expect(contract.trustedRuntimePackages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "@earendil-works/pi-ai", version: "0.83.0" }),
      expect.objectContaining({ name: "openai", version: "6.26.0", resolveFrom: "@earendil-works/pi-ai" }),
      expect.objectContaining({ name: "partial-json", version: "0.1.7", resolveFrom: "@earendil-works/pi-ai" }),
    ]));
    const extension = readFileSync(join(root, "scripts/pi/naia-versioned-billing-extension.mjs"), "utf8");
    expect(extension).toContain("@earendil-works/pi-ai/api/openai-completions.lazy");
    expect(extension).not.toContain("@earendil-works/pi-ai/compat");
    expect(extension).toContain('pi.on("tool_call"');
    expect(extension).toContain("workspaceToolPathViolation(ctx.cwd, event.input)");

    const source = readFileSync(runnerPath, "utf8");
    const paidArm = source.indexOf("candidate = await runArm");
    for (const gate of ["!confirmed", "!key", "contract.taskDigest !== actualTaskDigest",
      "contract.baselineDigest !== actualBaseline", "!pinnedPrices", "!journalKey",
      "actualJournalKeyId !== journalKeyId", "durable --output path is required"]) {
      expect(source.indexOf(gate), gate).toBeGreaterThanOrEqual(0);
      expect(source.indexOf(gate), gate).toBeLessThan(paidArm);
    }
    expect(source).not.toContain("rmSync(root");
    expect(source).toContain("initializeGatewayRequestBudget");
    expect(source).toContain("readGatewayRequestBudgetEvidence");
    expect(source).toContain("readNaiaPiReceiptJournal");
    expect(source).toContain("delete process.env.NAIA_BENCHMARK_JOURNAL_KEY");
    expect(source).toContain("delete process.env.PI_BIN");
    expect(source).toContain("env: withoutBenchmarkIntegrityKey(process.env)");
    expect(source).toContain("base.receiptAuthority.authentication.pinsDigest !== actualPinsDigest");
    expect(source.indexOf("attestationModule = await import")).toBeLessThan(source.indexOf('candidate = await runArm'));
    expect(source).toContain("assertTrustedRuntimeUnchanged(trustedRuntimeFiles, trustedRuntimeDigests)");
    expect(source).toContain("built benchmark runtime does not match the frozen trusted closure");
    expect(source).toContain('toolAllowlist: ["read", "write", "edit", "grep", "find", "ls"]');
    expect(source).toContain("beforeSpawn: assertFrozenRuntime");
    expect(source).toContain("assertTrustedRuntimeFileSetUnchanged(trustedExecutableFiles, collectTrustedExecutableFiles(trustedPiEntry))");
    expect(source).toContain("resolveBin: () => ({ command: process.execPath, prefixArgs: [trustedPiEntry] })");
    expect(source).toContain("spawnSync(trustedGitPath, invocation.args");
    expect(source).toContain("{ ...process.env, PATH: dirname(trustedGitPath) }");
    expect(source).toContain("digestFile(trustedGitPath) !== trustedGitDigest");
    expect(source).toContain("{ worktrees, changedFiles: secureGitChangedFiles, verifier }");
    expect(source).toContain("env: withoutBenchmarkCredentials(process.env)");
    expect(source).toContain('"benchmark/digest-tree.mjs"');
    expect(source).toContain("checkpoint reopen process failed");
    expect(source).toContain("status: \"unavailable\"");
    const guardedSetup = source.indexOf("try {", source.indexOf("let billingModule"));
    expect(guardedSetup).toBeGreaterThan(0);
    expect(source.indexOf("await import(pathToFileURL", guardedSetup)).toBeGreaterThan(guardedSetup);
    expect(source.indexOf("initializeGatewayRequestBudget", guardedSetup)).toBeGreaterThan(guardedSetup);
  });

  it("reopens the frozen tree in a separate process and reproduces its digest", () => {
    const run = spawnSync(process.execPath, [digestRunnerPath, fixturePath, "--ignore-git"],
      { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(digestTree(fixturePath));
  });

  it("exits with zero calls when explicit confirmation is absent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-cost-runner-test-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ };
    try {
      const output = join(temporary, "result.json");
      const run = spawnSync(process.execPath, [runnerPath, "--output", output], { cwd: root, env, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ schemaVersion: 2, status: "unavailable",
        paidCalls: 0, gatewayCalls: 0, reason: "explicit paid-comparison confirmation missing",
        costEfficiencyClaimAllowed: false });
      const first = readFileSync(output, "utf8");
      const repeated = spawnSync(process.execPath, [runnerPath, "--output", output], { cwd: root, env, encoding: "utf8" });
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({ reason: "paid comparison output or artifact path already exists" });
      expect(readFileSync(output, "utf8")).toBe(first);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("still exits with zero calls when confirmation exists but price versions are unpinned", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-cost-runner-test-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ,
      NAIA_API_KEY: "test-only-not-used", NAIA_PI_COST_CONFIRM: "1" };
    try {
      const output = join(temporary, "result.json");
      const run = spawnSync(process.execPath,
        [runnerPath, "--confirm-paid-comparison", "--output", output], { cwd: root, env, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ status: "unavailable", paidCalls: 0,
        gatewayCalls: 0, reason: "model price versions are not pinned", costEfficiencyClaimAllowed: false });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("runs the production analyzer handler with a valid, wrong, and missing external journal key", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "pi-cost-analyzer-test-"));
    const key = "offline-analyzer-integration-key-000000000000000000";
    try {
      const contract = JSON.parse(readFileSync(contractPath, "utf8"));
      const pins = { schemaVersion: 1, benchmarkId: contract.benchmarkId, taskDigest: contract.taskDigest,
        harnessJournalKeyId: piCostIntegrityKeyId(key),
        gitExecutablePath: "/trusted/git", gitExecutableDigest: `sha256:${"a".repeat(64)}`,
        priceVersionByModel: { "deepseek-v4-flash": "price-flash-test", "grok-4.3": "price-grok-test" } };
      const candidate = fullArm("candidate", contract, pins.priceVersionByModel, "0.00100000");
      const control = fullArm("control", contract, pins.priceVersionByModel, "0.00200000");
      const rows = [...candidate.sourceAudit.gatewayLedger, ...control.sourceAudit.gatewayLedger];
      // @ts-expect-error Production benchmark helpers are intentionally plain ESM.
      const runtimeTrust = await import("../../benchmark/pi-cost-runtime-trust.mjs");
      const runtimeFiles = { ...runtimeTrust.collectTrustedRuntimeFiles(join(root, "dist/main"), contract.trustedRuntimeModules),
        ...runtimeTrust.collectTrustedPackageFiles(root, contract.trustedRuntimePackages),
        ...runtimeTrust.collectTrustedExecutableFiles(
          join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")),
        ...Object.fromEntries(contract.trustedRuntimeArtifacts.map((name: string) => [name, join(root, name)])),
        "executable:pi": join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js") };
      const runtimeDigests = runtimeTrust.captureTrustedRuntimeDigests(runtimeFiles);
      const unsigned = { schemaVersion: 2, benchmarkId: contract.benchmarkId, taskDigest: contract.taskDigest,
        baselineDigest: contract.baselineDigest, minimumSavingsBasisPoints: contract.minimumSavingsBasisPoints,
        routePolicy: contract.routePolicy, expectedRoleCounts: contract.expectedRoleCounts,
        qualityPolicy: { scorerId: contract.quality.scorerId, requiredChecks: contract.quality.requiredChecks,
          allowedChangedFiles: contract.quality.allowedChangedFiles }, budgetPolicy: contract.budget,
        priceVersionPolicy: pins.priceVersionByModel,
        executionAuthority: { git: { path: pins.gitExecutablePath, digest: pins.gitExecutableDigest,
          source: "contract-bound-pins" } },
        trustedRuntimeModules: Object.keys(runtimeFiles), trustedRuntimeDigests: runtimeDigests,
        trustedRuntimeClosureDigest: runtimeTrust.trustedRuntimeManifestDigest(runtimeDigests),
        candidate, control, sharedGatewayLedger: { rows,
          snapshot: { gatewayCalls: rows.length, activeReservations: 0, chargedUsdDecimal: "0.02700000",
            chargedInputTokens: rows.length * 10, chargedOutputTokens: rows.length * 2 } } };
      const evidence = { ...unsigned, attestation: attestPiCostEvidence(unsigned,
        { integrityKey: key, expectedKeyId: pins.harnessJournalKeyId }) };
      const pinsPath = join(temporary, "pins.json"); const evidencePath = join(temporary, "evidence.json");
      const pinsBytes = JSON.stringify(pins); writeFileSync(pinsPath, pinsBytes); writeFileSync(evidencePath, JSON.stringify(evidence));
      const testContract = structuredClone(contract);
      testContract.receiptAuthority.authentication.pinsDigest =
        `sha256:${createHash("sha256").update(pinsBytes).digest("hex")}`;
      // @ts-expect-error Production benchmark entrypoints are intentionally plain ESM.
      const { runPiCostAnalyzerCli } = await import("../../benchmark/analyze-pi-cost-comparison.mjs");
      const invoke = (integrityKey?: string) => runPiCostAnalyzerCli(
        ["--pins", pinsPath, "--evidence", evidencePath],
        integrityKey ? { NAIA_BENCHMARK_JOURNAL_KEY: integrityKey } : {}, { baseContract: testContract });
      const valid = await invoke(key);
      expect(valid).toMatchObject({ exitCode: 0,
        payload: { status: "verified", costEfficiencyClaimAllowed: true } });
      for (const run of [await invoke("wrong-offline-analyzer-key-000000000000000000000"), await invoke()]) {
        expect(run).toMatchObject({ exitCode: 2,
          payload: { status: "unavailable", costEfficiencyClaimAllowed: false } });
      }
      await expect(runPiCostAnalyzerCli(["--pins", pinsPath, "--evidence", evidencePath],
        { NAIA_BENCHMARK_JOURNAL_KEY: key })).rejects.toThrow(/pins are not bound/u);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("isolates every benchmark Git child from hostile global hooks and the integrity key", async () => {
    // @ts-expect-error Production benchmark helpers are intentionally plain ESM.
    const { installBenchmarkProcessIsolation, makeBenchmarkGitInvocation } = await import("../../benchmark/pi-cost-git-isolation.mjs");
    const invocation = makeBenchmarkGitInvocation("/benchmark/isolation", ["commit", "-m", "fixture"],
      { GIT_AUTHOR_DATE: "2026-08-04T00:00:00Z" },
      { HOME: "/hostile/home", GIT_CONFIG_GLOBAL: "/hostile/global.gitconfig",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/hostile/hooks",
        GIT_DIR: "/hostile/repository", NAIA_BENCHMARK_JOURNAL_KEY: "must-not-reach-hook",
        NAIA_API_KEY: "must-not-reach-git", AZURE_API_KEY: "must-not-reach-git", PATH: "/bin" });
    expect(invocation.args).toEqual(["-c", "core.hooksPath=/benchmark/isolation/hooks", "commit", "-m", "fixture"]);
    expect(invocation.env).toMatchObject({ HOME: "/hostile/home", PATH: "/bin", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/benchmark/isolation/global.gitconfig", GIT_TERMINAL_PROMPT: "0" });
    expect(invocation.env).not.toHaveProperty("NAIA_BENCHMARK_JOURNAL_KEY");
    expect(invocation.env).not.toHaveProperty("NAIA_API_KEY");
    expect(invocation.env).not.toHaveProperty("AZURE_API_KEY");
    expect(invocation.env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/benchmark/isolation/hooks" });
    expect(invocation.env).not.toHaveProperty("GIT_DIR");
    const transitiveEnv: Record<string, string> = { NAIA_BENCHMARK_JOURNAL_KEY: "secret",
      GIT_CONFIG_COUNT: "1", GIT_DIR: "/hostile", PATH: "/bin" };
    installBenchmarkProcessIsolation("/benchmark/isolation", transitiveEnv);
    expect(transitiveEnv).toEqual({ PATH: "/bin", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/benchmark/isolation/global.gitconfig", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/benchmark/isolation/hooks",
      GIT_TERMINAL_PROMPT: "0" });
  });

  it("detects replacement of a preloaded trusted runtime before signing", async () => {
    // @ts-expect-error Production benchmark helpers are intentionally plain ESM.
    const { collectTrustedRuntimeFiles, captureTrustedRuntimeDigests, assertTrustedRuntimeUnchanged } = await import("../../benchmark/pi-cost-runtime-trust.mjs");
    const temporary = mkdtempSync(join(tmpdir(), "pi-runtime-trust-test-"));
    try {
      const modulePath = join(temporary, "signer.js"); const dependencyPath = join(temporary, "dependency.js");
      writeFileSync(modulePath, 'import "./dependency.js";\nexport const signer = true;\n');
      writeFileSync(dependencyPath, "export const dependency = true;\n");
      const files = collectTrustedRuntimeFiles(temporary, ["signer.js"]);
      expect(Object.keys(files)).toEqual(["dependency.js", "signer.js"]);
      const captured = captureTrustedRuntimeDigests(files);
      expect(() => assertTrustedRuntimeUnchanged(files, captured)).not.toThrow();
      writeFileSync(dependencyPath, "replaced-by-arm");
      expect(() => assertTrustedRuntimeUnchanged(files, captured)).toThrow(/changed after preload/u);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("binds a trusted external package closure and rejects undeclared bare imports", async () => {
    // @ts-expect-error Production benchmark helpers are intentionally plain ESM.
    const { collectTrustedPackageFiles, captureTrustedRuntimeDigests, assertTrustedRuntimeUnchanged } = await import("../../benchmark/pi-cost-runtime-trust.mjs");
    const temporary = mkdtempSync(join(tmpdir(), "pi-package-trust-test-"));
    try {
      const packageRoot = join(temporary, "node_modules/example"); mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
      writeFileSync(join(packageRoot, "dist/index.js"), 'import "./dependency.js";\nexport const value = true;\n');
      writeFileSync(join(packageRoot, "dist/dependency.js"), "export const dependency = true;\n");
      const files = collectTrustedPackageFiles(temporary,
        [{ name: "example", version: "1.0.0", modules: ["dist/index.js"] }]);
      expect(Object.keys(files)).toEqual([
        "npm:example/dist/dependency.js", "npm:example/dist/index.js", "npm:example/package.json",
      ]);
      const captured = captureTrustedRuntimeDigests(files);
      writeFileSync(join(packageRoot, "dist/dependency.js"), "replaced");
      expect(() => assertTrustedRuntimeUnchanged(files, captured)).toThrow(/changed after preload/u);
      writeFileSync(join(packageRoot, "dist/index.js"), 'import "undeclared";\n');
      expect(() => collectTrustedPackageFiles(temporary,
        [{ name: "example", version: "1.0.0", modules: ["dist/index.js"] }])).toThrow(/untrusted package import/u);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("binds the full transitive Pi executable closure", async () => {
    // @ts-expect-error Production benchmark helpers are intentionally plain ESM.
    const runtimeTrust = await import("../../benchmark/pi-cost-runtime-trust.mjs");
    const { assertTrustedRuntimeFileSetUnchanged, assertTrustedRuntimeUnchanged,
      captureTrustedRuntimeDigests, collectTrustedExecutableFiles } = runtimeTrust;
    const files = collectTrustedExecutableFiles(
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
    expect(files).toHaveProperty("npm-exec:@earendil-works/pi-coding-agent@0.83.0/dist/cli.js");
    expect(Object.keys(files).length).toBeGreaterThan(100);

    const temporary = mkdtempSync(join(tmpdir(), "pi-executable-closure-test-"));
    try {
      writeFileSync(join(temporary, "package.json"), JSON.stringify({ name: "fixture-executable", version: "1.0.0",
        type: "module" }));
      writeFileSync(join(temporary, "entry.js"), 'import "./dependency.js";\n');
      writeFileSync(join(temporary, "dependency.js"), "export const trusted = true;\n");
      const fixtureFiles = collectTrustedExecutableFiles(join(temporary, "entry.js"));
      writeFileSync(join(temporary, "extra.js"), "export const extra = true;\n");
      expect(() => assertTrustedRuntimeFileSetUnchanged(fixtureFiles,
        { ...fixtureFiles, "npm-exec:fixture-executable@1.0.0/extra.js": join(temporary, "extra.js") }))
        .toThrow(/file set changed/u);
      const captured = captureTrustedRuntimeDigests(fixtureFiles);
      writeFileSync(join(temporary, "dependency.js"), "export const trusted = false;\n");
      expect(() => assertTrustedRuntimeUnchanged(fixtureFiles, captured)).toThrow(/changed after preload/u);
      writeFileSync(join(temporary, "entry.js"), "const name = './dependency.js'; void import(name);\n");
      expect(() => collectTrustedExecutableFiles(join(temporary, "entry.js"))).toThrow(/computed dynamic import/u);
    } finally { rmSync(temporary, { recursive: true, force: true }); }

  });

  it("blocks every file-tool path that escapes the assigned workspace or crosses a symlink", async () => {
    // @ts-expect-error Production Pi extension helpers are intentionally plain ESM.
    const { WORKSPACE_PATH_TOOLS, workspaceToolPathViolation } = await import("../../scripts/pi/workspace-tool-boundary.mjs");
    const temporary = mkdtempSync(join(tmpdir(), "pi-workspace-boundary-test-"));
    try {
      const workspace = join(temporary, "workspace"); const outside = join(temporary, "outside");
      mkdirSync(workspace); mkdirSync(outside); writeFileSync(join(outside, "secret"), "secret");
      symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
      expect([...WORKSPACE_PATH_TOOLS].sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
      for (const input of [{ path: "src/new.ts" }, {}, { path: "." }]) {
        expect(workspaceToolPathViolation(workspace, input)).toBeUndefined();
      }
      for (const input of [{ path: "../outside/secret" }, { path: join(outside, "secret") },
        { path: `@${join(outside, "secret")}` }, { path: "@../outside/secret" },
        { path: "escape/secret" }, { path: 42 }]) {
        expect(workspaceToolPathViolation(workspace, input)).toMatch(/escapes|must be a string/u);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});

function fullArm(name: "candidate" | "control", contract: any, prices: Record<string, string>, cost: string): any {
  const actors: any[] = []; const calls: any[] = []; const receipts: any[] = [];
  const journalHeads: any[] = []; const journalReceipts: any[] = []; const gatewayLedger: any[] = [];
  let index = 0;
  for (const [role, count] of Object.entries(contract.expectedRoleCounts) as Array<[string, number]>) {
    for (let roleIndex = 0; roleIndex < count; roleIndex += 1) {
      index += 1; const actorExecutionId = `${name}-actor-${index}`; const executionId = `${name}-call-${index}`;
      const gatewayRequestId = `${name}-gateway-${index}`; const model = contract.routePolicy[name].roleModels[role];
      const actor = { executionId: actorExecutionId, role, provider: "naia", model };
      const call = { ...actor, executionId, actorExecutionId, inputTokens: 10, outputTokens: 2 };
      const receipt = { ...call, gatewayRequestId, priceVersionId: prices[model],
        source: "gateway_versioned_customer_billing", settlementStatus: "settled",
        customerCostDecimal: cost, customerCostUsd: Number(cost) };
      actors.push(actor); calls.push(call); receipts.push(receipt);
      journalHeads.push({ executionId: actorExecutionId, headDigest: `${name}-head-${index}`, entryCount: 1 });
      journalReceipts.push({ ...receipt, journalEntryDigest: `${name}-entry-${index}`,
        ledgerReceiptDigest: `${name}-digest-${index}` });
      gatewayLedger.push({ requestId: gatewayRequestId, status: "settled", actualCostDecimal: cost,
        actualInputTokens: 10, actualOutputTokens: 2, receiptDigest: `${name}-digest-${index}` });
    }
  }
  const total = (BigInt(cost.replace(".", "")) * BigInt(index)).toString().padStart(9, "0");
  const chargedUsdDecimal = `${total.slice(0, -8)}.${total.slice(-8)}`;
  return { taskDigest: contract.taskDigest, status: "completed",
    checkpoint: { beforeCloseDigest: contract.baselineDigest, afterOpenDigest: contract.baselineDigest },
    scorerId: contract.quality.scorerId, checks: contract.quality.requiredChecks.map((check: string) => ({ name: check, pass: true })),
    changedFiles: contract.quality.allowedChangedFiles, actorAttempts: actors, calls, receipts,
    sourceAudit: { journalHeads, journalReceipts, gatewayLedger,
      gatewayBudget: { gatewayCalls: index, activeReservations: 0, chargedUsdDecimal,
        chargedInputTokens: index * 10, chargedOutputTokens: index * 2 } },
    localBudget: { paidCalls: index, activeReservations: 0 } };
}

function digestTree(path: string): string {
  const hash = createHash("sha256");
  for (const file of walk(path)) {
    hash.update(relative(path, file).replaceAll("\\", "/")); hash.update("\0");
    hash.update(readFileSync(file)); hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function walk(path: string): string[] {
  return readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? walk(child) : [child];
  });
}
