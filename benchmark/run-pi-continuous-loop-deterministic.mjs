#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const corpusPath = fileURLToPath(new URL("./orchestration/pi-continuous-loop-deterministic.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
if (corpus.paidCalls !== 0 || corpus.cases.length < 8) throw new Error("benchmark must be moderate and zero-paid");
const distArg = process.argv.indexOf("--dist-dir");
const distRoot = distArg >= 0 ? resolve(process.argv[distArg + 1]) : join(repositoryRoot, "dist");
const closureRoots = ["src/main/composition/pi-continuous-loop.ts"];
const importClosure = collectTypescriptClosure(closureRoots);
const distConformance = verifyExecutedDist(importClosure, distRoot);
const { SqlitePaidCallBudget, PaidCallAlreadyReservedError, PaidCallBudgetExceededError, PaidCallReceiptConflictError } =
  await import(pathToFileURL(join(distRoot, "main/adapters/sqlite-paid-call-budget.js")));
const { makePiContinuousLoop, makePiOnlyTeamProfile } =
  await import(pathToFileURL(join(distRoot, "main/composition/pi-continuous-loop.js")));
const trackedInputs = ["benchmark/orchestration/pi-continuous-loop-deterministic.json",
  "benchmark/run-pi-continuous-loop-deterministic.mjs", "package.json", "pnpm-lock.yaml", "tsconfig.json",
  ...importClosure].sort();
const root = mkdtempSync(join(tmpdir(), "naia-pi-loop-benchmark-"));

try {
  const db = join(root, "budget.db");
  let budget = new SqlitePaidCallBudget(db, corpus.policy);
  for (const item of corpus.cases) {
    budget.reserve({ idempotencyKey: item.id, expectedProvider: "fixture", expectedModel: "fixture", ...corpus.reservation });
    if (item.state === "settled") budget.settle(item.id, receipt(item));
  }
  const beforeRestart = budget.snapshot(); budget.close();
  budget = new SqlitePaidCallBudget(db, corpus.policy);
  const afterRestart = budget.snapshot();
  let duplicateBlocked = false; let exhaustionBlocked = false;
  try { budget.reserve({ idempotencyKey: corpus.cases.at(-1).id, expectedProvider: "fixture", expectedModel: "fixture", ...corpus.reservation }); }
  catch (error) { duplicateBlocked = error instanceof PaidCallAlreadyReservedError; }
  try { budget.reserve({ idempotencyKey: "budget-probe", expectedProvider: "fixture", expectedModel: "fixture", reservedUsd: corpus.policy.maxUsd,
    reservedInputTokens: corpus.policy.maxInputTokens, reservedOutputTokens: corpus.policy.maxOutputTokens }); }
  catch (error) { exhaustionBlocked = error instanceof PaidCallBudgetExceededError; }
  let receiptConflictBlocked = false; let driftBlockedAndReserved = false;
  try { budget.settle(corpus.cases[0].id, { ...receipt(corpus.cases[0]), outputTokens: corpus.cases[0].output + 1 }); }
  catch (error) { receiptConflictBlocked = error instanceof PaidCallReceiptConflictError; }
  try { budget.settle("issue-b:implementer-crash", { ...receipt({ ...corpus.cases[6], input: 1, output: 1, usd: 0.001 }), model: "drifted" }); }
  catch (error) { driftBlockedAndReserved = error instanceof PaidCallReceiptConflictError
    && budget.reservations().some((item) => item.idempotencyKey === "issue-b:implementer-crash" && item.status === "active"); }
  const profile = makePiOnlyTeamProfile({ roles: corpus.profile, maxRepairCycles: 2, requiredCleanCycles: 2 });
  const endToEnd = await runEndToEnd(root, profile);
  const openCodeRuntimeEdges = findOpenCodeRuntimeEdges(importClosure);
  const openCodeDetectorSelfTest = selfTestOpenCodeDetector();
  const gates = {
    moderateCorpus: corpus.cases.length >= 8,
    zeroPaidCalls: corpus.paidCalls === 0,
    restartExact: JSON.stringify(beforeRestart) === JSON.stringify(afterRestart),
    unresolvedPreserved: afterRestart.activeReservations === corpus.cases.filter((item) => item.state === "unresolved").length,
    duplicateBlocked, exhaustionBlocked, receiptConflictBlocked, driftBlockedAndReserved,
    multiIssueTerminal: endToEnd.states.length === 2 && endToEnd.states.includes("completed") && endToEnd.states.includes("failed"),
    duplicateSubmitDeduplicated: endToEnd.duplicateSubmitDeduplicated,
    repairObserved: endToEnd.repairCycles >= 1,
    verificationFailurePreserved: endToEnd.states.includes("failed"),
    controlRestartExact: endToEnd.restartExact,
    compositionBudgetSettled: endToEnd.budget.activeReservations === 0
      && endToEnd.budget.paidCalls === endToEnd.modelEffects,
    executedDistMatchesSource: distConformance.exact,
    importClosureComplete: closureRoots.every((path) => importClosure.includes(path)) && importClosure.length >= 30,
    allRolesPi: Object.values(profile.roles).every((role) => role.agentKind === "pi"),
    onlyImplementerWrites: Object.entries(profile.roles).filter(([, role]) => role.filesystemAccess === "workspace_write")
      .map(([role]) => role).join(",") === "implementer",
    openCodeDetectorSelfTest: openCodeDetectorSelfTest.pass,
    noOpenCodeEdge: openCodeRuntimeEdges.length === 0,
  };
  const evidence = { beforeRestart, afterRestart, profile, endToEnd, closureRoots, importClosureCount: importClosure.length,
    openCodeRuntimeEdges, openCodeDetectorSelfTest, distConformance,
    trackedInputs: Object.fromEntries(trackedInputs.map((path) => [path, sha256(join(repositoryRoot, path))])) };
  const result = { schemaVersion: corpus.schemaVersion, benchmarkId: corpus.benchmarkId,
    sourceTreeDigest: sha256Text(JSON.stringify(evidence.trackedInputs)),
    executionTreeDigest: sha256Text(JSON.stringify(distConformance.executedArtifacts)), paidCalls: 0, gates, evidence,
    claimAllowed: Object.values(gates).every(Boolean), costClaim: "deterministic harness only; no live Azure price comparison" };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const outputArg = process.argv.indexOf("--output");
  if (outputArg >= 0) writeFileSync(resolve(process.argv[outputArg + 1]), serialized, { mode: 0o600 });
  process.stdout.write(serialized);
  if (!result.claimAllowed) process.exitCode = 1;
  budget.close();
} finally { rmSync(root, { recursive: true, force: true }); }

async function runEndToEnd(root, profile) {
  const binding = { provider: "naia", model: "deepseek-v4-pro" };
  let modelEffects = 0; let testerCalls = 0; let issueSequence = 0; let sessionSequence = 0; let clock = 1_000;
  const runtime = { makeSubAgent(selected) { return fixtureSubAgent(selected, () => ++modelEffects, () => ++testerCalls); },
    worktrees: { allocate(input) { return { workspacePath: input.workspacePath,
      worktreePath: join(root, "fixture-worktrees", input.jobId), branch: `fixture/${input.jobId}`,
      leaseId: `lease/${input.jobId}`, release() {} }; } }, changedFiles: () => ["src/fix.ts"],
    verifier: { async verify(input) { const ok = input.issueId === "issue-1"; return { ok,
      checks: [{ name: "fixture-check", pass: ok }],
      receipt: actorReceipt("verifier", input.idempotencyKey, input.issueId, "fixture", "verifier") }; } },
    issueIds: () => `issue-${++issueSequence}`, issueOwnerIds: () => `issue-owner-${issueSequence}`,
    sessionIds: () => `session-${++sessionSequence}`, sessionOwnerIds: () => "session-owner",
    now: () => "2026-08-04T00:00:00.000Z", clockMs: () => clock++ };
  const config = { stateDir: join(root, "e2e-state"), workspaceRoot: root,
    worktreeRoot: join(root, "fixture-worktrees"), facing: binding, moderator: binding, reporter: binding,
    roles: corpus.profile, profileId: "economy-pi", maxRepairCycles: 2, requiredCleanCycles: 2,
    acceptanceChecks: [{ name: "fixture-check", command: "unused", args: [] }], concurrency: 2,
    budget: { maxPaidCalls: 40, maxUsd: 0.2, maxInputTokens: 40_000, maxOutputTokens: 20_000 },
    callAllowance: { reservedUsd: 0.005, reservedInputTokens: 1_000, reservedOutputTokens: 500 },
    diag: { log() {}, debug() {} } };
  let loop = makePiContinuousLoop(config, runtime);
  const submission = (id) => ({ request: { requestId: id, text: `implement ${id}`, requiredObligations: [`finish ${id}`],
    workspacePath: `/workspace/${id}`, naiaBinding: binding, moderatorBinding: binding,
    workerProfiles: { "economy-pi": profile } },
    source: { kind: "local", sourceId: `source-${id}`, actorId: "benchmark" } });
  const first = await loop.sessions.submit(submission("a"));
  const duplicate = await loop.sessions.submit(submission("a"));
  await loop.sessions.submit(submission("b"));
  await loop.sessions.pump();
  const before = loop.sessions.portfolio();
  const repairCycles = before.sessions.reduce((sum, session) => sum
    + (loop.issues.snapshot(session.issueId)?.worker?.team?.repairCycles ?? 0), 0);
  const states = before.sessions.map((session) => session.state).sort();
  const reports = before.sessions.map((session) => ({ sessionId: session.sessionId, issueId: session.issueId,
    state: session.state, report: session.report, issueState: loop.issues.snapshot(session.issueId)?.state,
    verification: loop.issues.snapshot(session.issueId)?.verification }));
  const budget = loop.budget.snapshot(); loop.close();
  loop = makePiContinuousLoop(config, runtime);
  const afterStates = loop.sessions.portfolio().sessions.map((session) => session.state).sort();
  loop.close();
  return { states, reports, repairCycles, duplicateSubmitDeduplicated: first.sessionId === duplicate.sessionId,
    restartExact: JSON.stringify(states) === JSON.stringify(afterStates), modelEffects, budget };
}

function fixtureSubAgent(binding, countEffect, countTester) {
  return { spawn(task) { const n = countEffect(); const text = fixtureResponse(task.prompt, countTester);
    const evidence = { provider: binding.provider, selectedModel: binding.model, modelEvidenceSource: "provider_reported",
      usageAvailable: true, inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, totalTokens: 13,
      piEstimatedCost: 0.001, sessionId: `pi-session-${n}`, executionId: `pi-execution-${n}` };
    return { async cancel() {}, events: (async function* () { yield { kind: "text_delta", text };
      yield { kind: "model_evidence", evidence }; yield { kind: "session_end", ok: true, evidence }; })() };
  } };
}

function fixtureResponse(prompt, countTester) {
  if (prompt.includes("low-cost conversational front layer")) {
    const obligations = JSON.parse(prompt.match(/exact ordered obligation array: (\[[^\n]+\])/u)?.[1] ?? "[]");
    return JSON.stringify({ kind: "work", obligations });
  }
  if (prompt.includes("separate senior development moderator")) return JSON.stringify({ workerTask: "fixture change",
    workerProfile: "economy-pi", acceptanceChecks: ["fixture-check"], questions: [] });
  if (prompt.includes("user-facing reporter")) {
    const marker = "Return this exact JSON value without changing any text: ";
    const line = prompt.split("\n").find((item) => item.startsWith(marker));
    if (!line) throw new Error("fixture reporter prompt unavailable");
    return line.slice(marker.length, -1);
  }
  const role = prompt.match(/You are the (explorer|implementer|tester|reviewer)/u)?.[1];
  if (!role) throw new Error("fixture role prompt unavailable");
  const repair = role === "tester" && countTester() === 1;
  const decision = role === "explorer" ? "proceed" : role === "implementer" ? "implemented"
    : role === "tester" ? repair ? "fail" : "pass" : "clean";
  return JSON.stringify({ version: 1, role, decision, summary: `${role}:${decision}`,
    findings: repair ? [{ code: "FIXTURE_REPAIR", message: "repair once" }] : [] });
}

function actorReceipt(role, key, n, provider, model) { return { role, provider, model,
  sessionId: `fixture-session-${n}`, executionId: `fixture-execution-${n}`, idempotencyKey: key,
  tokenCountsAvailable: true, inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, latencyMs: 1,
  modelEvidenceSource: "provider_reported", cost: { state: "measured", usd: 0.001, source: "fixture" } }; }

function receipt(item) { return { role: "worker", provider: "fixture", model: "fixture", sessionId: `s-${item.id}`,
  executionId: `e-${item.id}`, idempotencyKey: item.id, tokenCountsAvailable: true, inputTokens: item.input,
  cachedInputTokens: 0, outputTokens: item.output, latencyMs: 1, modelEvidenceSource: "provider_reported",
  cost: { state: "measured", usd: item.usd, source: "fixture" } }; }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sha256Text(value) { return createHash("sha256").update(value).digest("hex"); }

function collectTypescriptClosure(roots) {
  const pending = [...roots]; const visited = new Set();
  while (pending.length > 0) {
    const relative = pending.pop(); if (visited.has(relative)) continue;
    const absolute = join(repositoryRoot, relative);
    if (!existsSync(absolute)) throw new Error(`tracked TypeScript input missing: ${relative}`);
    visited.add(relative);
    const sourceText = readFileSync(absolute, "utf8");
    const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const specifier of typescriptModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const base = resolve(join(repositoryRoot, relative, ".."), specifier);
      const candidates = [base.replace(/\.js$/u, ".ts"), `${base}.ts`, join(base, "index.ts")];
      const target = candidates.find((candidate) => existsSync(candidate));
      if (!target) throw new Error(`unresolved relative TypeScript import from ${relative}: ${specifier}`);
      pending.push(relativePath(repositoryRoot, target).replaceAll("\\", "/"));
    }
  }
  return [...visited].sort();
}

function typescriptModuleSpecifiers(source) {
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = resolvedStaticString(node.arguments[0], new Map());
      if (!target) throw new Error(`unresolved dynamic import in ${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      specifiers.push(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function verifyExecutedDist(paths, root) {
  const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(join(repositoryRoot, "tsconfig.json"), "utf8")),
    ts.sys, repositoryRoot);
  const mismatches = [];
  const executedArtifacts = {};
  for (const sourcePath of paths) {
    const sourceText = readFileSync(join(repositoryRoot, sourcePath), "utf8");
    const emitted = ts.transpileModule(sourceText, { compilerOptions: config.options, fileName: sourcePath }).outputText;
    const runtimePath = sourcePath.replace(/^src\//u, "").replace(/\.ts$/u, ".js");
    const absoluteRuntimePath = join(root, runtimePath);
    if (!existsSync(absoluteRuntimePath)) throw new Error(`executed dist input missing: ${absoluteRuntimePath}`);
    const runtimeText = readFileSync(absoluteRuntimePath, "utf8");
    if (runtimeText !== emitted) mismatches.push(runtimePath);
    executedArtifacts[runtimePath] = sha256(absoluteRuntimePath);
  }
  return { exact: mismatches.length === 0, mismatches, executedArtifacts };
}

function findOpenCodeRuntimeEdges(paths) {
  return paths.flatMap((path) => inspectOpenCodeRuntimeEdges(path, readFileSync(join(repositoryRoot, path), "utf8")));
}

function inspectOpenCodeRuntimeEdges(path, sourceText) {
  const edges = [];
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const childProcessAliases = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
  const childProcessNamespaces = new Set();
  const constantInitializers = new Map();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = statement.moduleSpecifier.text;
      if (isOpenCodeReference(target)) edges.push(edge(path, statement, source, "import", target));
      if (target === "node:child_process" || target === "child_process") {
        const clause = statement.importClause;
        if (clause?.name) childProcessNamespaces.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const item of clause.namedBindings.elements) {
            const imported = item.propertyName?.text ?? item.name.text;
            if (["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"].includes(imported)) {
              childProcessAliases.add(item.name.text);
            }
          }
        } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          childProcessNamespaces.add(clause.namedBindings.name.text);
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      && isOpenCodeReference(statement.moduleSpecifier.text)) {
      edges.push(edge(path, statement, source, "export", statement.moduleSpecifier.text));
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          constantInitializers.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && ["require", "createRequire"].includes(node.expression.text)) {
        edges.push(edge(path, node, source, "commonjs-runtime", node.expression.text));
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = resolvedStaticString(node.arguments[0], constantInitializers);
        if (!target) edges.push(edge(path, node, source, "unresolved-dynamic-import", node.getText(source)));
        else if (isOpenCodeReference(target)) edges.push(edge(path, node, source, "dynamic-import", target));
      } else if (isExecutableCall(node.expression, childProcessAliases, childProcessNamespaces, constantInitializers)) {
        const command = resolvedOpenCodeReference(node.arguments[0], constantInitializers);
        if (command) edges.push(edge(path, node, source, "executable", command));
      } else {
        const value = node.arguments.map((argument) => resolvedOpenCodeReference(argument, constantInitializers))
          .find((candidate) => candidate !== undefined);
        if (value) edges.push(edge(path, node, source, "runtime-call-argument", value));
      }
    } else if (ts.isPropertyAssignment(node) && isExecutableProperty(node.name)) {
      const command = resolvedOpenCodeReference(node.initializer, constantInitializers);
      if (command) edges.push(edge(path, node, source, "executable-config", command));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

function selfTestOpenCodeDetector() {
  const cases = [
    { name: "static-import", source: 'import value from "./renamed-opencode-adapter.js";', expected: 1 },
    { name: "aliased-spawn", source: 'import { spawn as launch } from "node:child_process";\nconst tool = "opencode";\nlaunch(tool, []);', expected: 1 },
    { name: "secondary-alias", source: 'import { spawn } from "node:child_process";\nconst launch = spawn;\nlaunch("opencode", []);', expected: 1 },
    { name: "default-child-process", source: 'import cp from "node:child_process";\ncp.spawn("opencode", []);', expected: 1 },
    { name: "commonjs", source: 'require("node:child_process").exec("opencode");', expected: 2 },
    { name: "computed-dynamic-import", source: 'const name = "renamed";\nconst target = `./${name}-opencode.js`;\nimport(target);', expected: 1 },
    { name: "renamed-wrapper", source: 'const first = "open";\nconst second = "code";\nrunTool(first + second);', expected: 1 },
    { name: "fallback-command", source: 'resolveFallbackCommand("opencode");', expected: 1 },
    { name: "compatibility-label", source: 'type AgentKind = "pi" | "opencode";\nconst selected: AgentKind = "pi";', expected: 0 },
  ].map((item) => ({ name: item.name, expected: item.expected,
    actual: inspectOpenCodeRuntimeEdges(`self-test/${item.name}.ts`, item.source).length }));
  return { pass: cases.every((item) => item.actual === item.expected), cases };
}

function isExecutableCall(expression, aliases, namespaces, constants, seen = new Set()) {
  if (ts.isIdentifier(expression)) {
    if (aliases.has(expression.text) || expression.text === "resolveFallbackCommand") return true;
    if (seen.has(expression.text)) return false;
    const initializer = constants.get(expression.text);
    if (!initializer) return false;
    seen.add(expression.text);
    return isExecutableCall(initializer, aliases, namespaces, constants, seen);
  }
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && namespaces.has(expression.expression.text)
    && aliases.has(expression.name.text);
}

function isExecutableProperty(name) {
  const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
  return ["command", "executable", "fallbackCommand", "prefixArgs"].includes(text);
}

function resolvedOpenCodeReference(node, constants, seen = new Set()) {
  if (!node) return undefined;
  const staticValue = resolvedStaticString(node, constants, new Set(seen));
  if (staticValue && isOpenCodeReference(staticValue)) return staticValue;
  if (ts.isStringLiteralLike(node)) return isOpenCodeReference(node.text) ? node.text : undefined;
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = constants.get(node.text);
    if (!initializer) return undefined;
    seen.add(node.text);
    return resolvedOpenCodeReference(initializer, constants, seen);
  }
  for (const child of node.getChildren()) {
    const found = resolvedOpenCodeReference(child, constants, seen);
    if (found) return found;
  }
  return undefined;
}

function resolvedStaticString(node, constants, seen = new Set()) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = constants.get(node.text);
    if (!initializer) return undefined;
    seen.add(node.text);
    return resolvedStaticString(initializer, constants, seen);
  }
  if (ts.isParenthesizedExpression(node)) return resolvedStaticString(node.expression, constants, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolvedStaticString(node.left, constants, new Set(seen));
    const right = resolvedStaticString(node.right, constants, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = resolvedStaticString(span.expression, constants, new Set(seen));
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function isOpenCodeReference(value) {
  return /(?:^|[\\/@-])opencode(?:$|[\\/@.-])/iu.test(value);
}

function edge(path, node, source, kind, value) {
  return { path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, value };
}
