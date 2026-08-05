#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const endpoint = process.env.NAIA_LOCAL_OPENAI_BASE_URL ?? "http://127.0.0.1:8000/v1";
const endpointUrl = validateLoopbackEndpoint(endpoint);
const provider = process.env.NAIA_LOCAL_PROVIDER ?? "local-vllm";
const model = process.env.NAIA_LOCAL_MODEL ?? "naia-0.9-coding-24g";
const expectedGpu = Number(process.env.NAIA_LOCAL_GPU_INDEX ?? "1");
const runtimeContainer = process.env.NAIA_LOCAL_RUNTIME_CONTAINER;
const declaredContextWindow = process.env.NAIA_LOCAL_CONTEXT_WINDOW === undefined
  ? undefined : Number(process.env.NAIA_LOCAL_CONTEXT_WINDOW);
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : undefined;
if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith("--"))) {
  throw new Error("--output requires a path");
}
let outputLockPath;
const trustedExecutables = Object.fromEntries(["git", "podman", "nvidia-smi", "ss"].map((name) => {
  const path = resolveExecutable(name);
  return [name, { path, sha256: sha256(path) }];
}));
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  if (existsSync(outputPath)) throw new Error("live benchmark output path already exists");
  outputLockPath = `${outputPath}.claim`;
  const claim = openSync(outputLockPath, "wx", 0o600); closeSync(claim);
}
const root = mkdtempSync(join(tmpdir(), "naia-user-owned-three-layer-"));
const source = join(root, "source");
const startedAt = new Date().toISOString(); const startedMs = Date.now();
let evidenceProxy;

try {
  const catalog = await fetch(`${endpoint}/models`).then(async (response) => {
    if (!response.ok) throw new Error(`local model catalog failed: HTTP ${response.status}`);
    return response.json();
  });
  const served = catalog.data?.find((item) => item.id === model);
  const contextWindow = Number(served?.max_model_len ?? declaredContextWindow);
  if (!served || !Number.isSafeInteger(contextWindow) || contextWindow < 32_768) {
    throw new Error("local endpoint must expose the declared model and measured-or-runtime-declared >=32K context");
  }
  if (!Number.isSafeInteger(expectedGpu) || expectedGpu < 0 || !runtimeContainer) {
    throw new Error("live evidence requires NAIA_LOCAL_GPU_INDEX and NAIA_LOCAL_RUNTIME_CONTAINER");
  }
  const runtime = await inspectRuntime(runtimeContainer, expectedGpu, served, endpointUrl, trustedExecutables);
  const contextProbe = await probeLongContext(endpoint, model);
  const nativeProtocol = [];
  const proxy = await startEvidenceProxy(endpoint, nativeProtocol); evidenceProxy = proxy;
  cpSync(join(repositoryRoot, "benchmark/fixtures/pi-cost-comparison/base"), source, { recursive: true });
  git(source, ["init", "-b", "main"]); git(source, ["config", "user.email", "benchmark@nextain.invalid"]);
  git(source, ["config", "user.name", "Naia Benchmark"]); git(source, ["add", "."]); git(source, ["commit", "-m", "fixture baseline"]);
  const dist = join(repositoryRoot, "dist");
  const closureRoots = ["src/main/composition/pi-continuous-loop.ts", "src/main/adapters/coding-job-worktree.ts",
    "src/main/adapters/subagent-pi.ts"];
  const importClosure = [...new Set(closureRoots.flatMap((entry) => collectTypescriptClosure([entry])))].sort();
  const distConformance = verifyExecutedDist(importClosure, dist);
  if (!distConformance.exact) throw new Error(`executed dist differs from source: ${distConformance.mismatches.join(", ")}`);
  const { makePiContinuousLoop } = await import(pathToFileURL(join(dist, "main/composition/pi-continuous-loop.js")));
  const { makeGitCodingJobWorktrees } = await import(pathToFileURL(join(dist, "main/adapters/coding-job-worktree.js")));
  const { makePiSubAgent } = await import(pathToFileURL(join(dist, "main/adapters/subagent-pi.js")));
  const piEntry = join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  if (!existsSync(piEntry)) throw new Error("workspace Pi 0.83 executable is unavailable");
  const binding = { provider, model };
  const localProvider = { id: provider, baseUrl: proxy.baseUrl,
    models: [{ id: model, name: process.env.NAIA_LOCAL_MODEL_NAME ?? model, contextWindow, maxTokens: 2_000 }] };
  const transcripts = [];
  const checks = [{ name: "file-content", command: process.execPath,
    args: ["-e", "const fs=require('node:fs');if(fs.readFileSync('src/answer.js','utf8').trim()!=='export const answer = 42;')process.exit(1)"] },
  { name: "changed-files", command: process.execPath,
    args: ["-e", `const{execFileSync}=require('node:child_process');const s=execFileSync(${JSON.stringify(trustedExecutables.git.path)},['status','--porcelain','--untracked-files=all'],{encoding:'utf8',env:{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();if(s!=='?? src/answer.js')process.exit(1)`] }];
  const worktrees = makeGitCodingJobWorktrees({ allowedWorkspaceRoot: source, worktreeRoot: join(root, "worktrees"),
    git: (args, cwd) => { git(cwd, args, { stdio: "ignore" }); } });
  const loop = makePiContinuousLoop({ stateDir: join(root, "state"), workspaceRoot: source,
    worktreeRoot: join(root, "worktrees"), facing: binding, moderator: binding, reporter: binding,
    roles: { explorer: binding, implementer: binding, tester: binding, reviewer: binding },
    profileId: "user-owned-local-pi", maxRepairCycles: 1, requiredCleanCycles: 2,
    acceptanceChecks: checks, concurrency: 1,
    budget: { maxPaidCalls: 12, maxUsd: 0.12, maxInputTokens: 384_000, maxOutputTokens: 24_000 },
    callAllowance: { reservedUsd: 0.01, reservedInputTokens: 32_000, reservedOutputTokens: 2_000 },
    pi: { piConfigDir: join(root, "pi"), toolAllowlist: ["read", "write", "edit", "grep", "find", "ls"],
      resolveBin: () => ({ command: process.execPath, prefixArgs: [piEntry] }),
      userOwnedProvider: localProvider },
    diag: { log() {}, debug() {} } }, { worktrees,
      makeSubAgent(_binding, write) {
        const base = makePiSubAgent({ provider, model, piConfigDir: join(root, "pi"), userOwnedProvider: localProvider,
          toolAllowlist: ["read", "write", "edit", "grep", "find", "ls"],
          resolveBin: () => ({ command: process.execPath, prefixArgs: [piEntry] }) });
        return { spawn(task) { const session = base.spawn(task); let text = ""; const record = { role: roleFromPrompt(task.prompt), write, text: "", events: [] };
          transcripts.push(record); return { cancel: (reason) => session.cancel(reason), events: (async function* () {
            for await (const event of session.events) { record.events.push(event.kind === "tool_use_start"
              ? { kind: event.kind, tool: event.tool } : event.kind === "tool_use_end"
                ? { kind: event.kind, tool: event.tool, ok: event.ok } : { kind: event.kind });
              if (event.kind === "text_delta") text += event.text;
              if (event.kind === "session_end") record.text = text; yield event; }
          })() }; } };
      } });
  try {
    const submitted = await loop.sessions.submit({ request: { requestId: "gpu1-user-owned-three-layer-v1",
      text: "Create src/answer.js whose exact trimmed bytes are `export const answer = 42;` and do not modify any other tracked file.",
      requiredObligations: ["src/answer.js exists", "src/answer.js exact trimmed bytes are `export const answer = 42;`", "no other tracked file changes"],
      workspacePath: source, naiaBinding: binding, moderatorBinding: binding,
      workerProfiles: { "user-owned-local-pi": loop.profile } },
    source: { kind: "local", sourceId: "gpu1-user-owned-three-layer-v1", actorId: "benchmark" } });
    await loop.sessions.pump();
    const session = loop.sessions.get(submitted.sessionId); const issue = loop.issues.snapshot(submitted.issueId);
    const worktree = issue?.worker?.worktreePath; const changedFiles = worktree ? git(worktree, ["status", "--porcelain", "--untracked-files=all"]).trim().split(/\r?\n/u).filter(Boolean) : [];
    const answer = worktree && existsSync(join(worktree, "src/answer.js")) ? readFileSync(join(worktree, "src/answer.js"), "utf8").trim() : null;
    const trackedInputs = ["benchmark/run-user-owned-three-layer-live.mjs", "package.json", "pnpm-lock.yaml",
      "scripts/pi/naia-versioned-billing-extension.mjs", ...importClosure].sort();
    const executionBinding = { sourceTreeDigest: sha256Text(JSON.stringify(Object.fromEntries(
      trackedInputs.map((path) => [path, sha256(join(repositoryRoot, path))])))), distConformance,
      piExecutable: { path: relativePath(repositoryRoot, piEntry).replaceAll("\\", "/"), sha256: sha256(piEntry) },
      trustedExecutables };
    const result = { schemaVersion: 2, benchmarkId: "gpu1-user-owned-three-layer-v1", startedAt,
      completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs,
      endpoint: { provider, model, servedRoot: served.root, maxModelLen: contextWindow, gpu: expectedGpu,
        contextEvidence: served.max_model_len === undefined ? "runtime_declared" : "endpoint_reported" },
      runtime, contextProbe, executionBinding, nativeProtocol,
      status: session.state, issueState: issue?.state, session, issue, answer, changedFiles,
      verification: issue?.verification, team: issue?.worker?.team, transcripts, receipts: issue?.receipts,
      budget: loop.budget.snapshot(),
      gates: { completed: session.state === "completed", exactArtifact: answer === "export const answer = 42;",
        onlyAllowedFile: changedFiles.length === 1 && changedFiles[0] === "?? src/answer.js",
        allActorsLocal: issue?.receipts.filter((receipt) => receipt.role !== "verifier")
          .every((receipt) => receipt.provider === provider && receipt.model === model),
        providerCostNotFaked: issue?.receipts.filter((receipt) => receipt.role !== "verifier")
          .every((receipt) => receipt.cost.state === "unavailable"),
        contextAtLeast32K: contextWindow >= 32_768 && contextProbe.promptTokens >= 32_768,
        sourceDistExact: distConformance.exact,
        gpuBound: runtime.endpointBinding.bound && runtime.gpu.index === expectedGpu && runtime.container.privileged === false
          && runtime.container.gpuDevices.length === 1 && runtime.container.gpuDevices[0] === `/dev/nvidia${expectedGpu}`
          && runtime.gpu.containerVisible.length === 1
          && runtime.gpu.containerVisible[0].uuid === runtime.gpu.uuid,
        runtimeModelBound: runtime.container.command[0] === served.root && runtime.container.command.includes(model)
          && runtime.container.command.includes(String(contextWindow)) && runtime.container.command.includes("--revision")
          && runtime.container.command.includes(runtime.model.snapshotRevision)
          && Boolean(runtime.container.imageId && runtime.container.imageDigest),
        nativeToolProtocol: nativeProtocol.some((call) => { const path = typeof call.arguments.path === "string"
          ? call.arguments.path.replaceAll("\\", "/") : "";
          return call.name === "write" && call.declaredTools.includes("write")
            && (path === "src/answer.js" || path.endsWith("/src/answer.js")); })
          && transcripts.some((record) => record.role === "implementer"
            && record.events.some((event) => event.kind === "tool_use_end" && event.tool === "write" && event.ok === true)) },
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (outputPath) writeFileSync(outputPath, serialized, { mode: 0o600, flag: "wx" });
    process.stdout.write(serialized);
    if (!Object.values(result.gates).every(Boolean)) process.exitCode = 1;
  } finally { loop.close(); }
} finally {
  if (evidenceProxy) await evidenceProxy.close();
  rmSync(root, { recursive: true, force: true });
  if (outputLockPath) rmSync(outputLockPath, { force: true });
}

function git(cwd, args, extra = {}) {
  assertExecutableUnchanged("git");
  return execFileSync(trustedExecutables.git.path, args, { cwd, encoding: "utf8", ...extra,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
}

function roleFromPrompt(prompt) {
  if (prompt.includes("low-cost conversational front layer")) return "facing";
  if (prompt.includes("separate senior development moderator")) return "moderator";
  if (prompt.includes("user-facing reporter")) return "reporter";
  return prompt.match(/You are the (explorer|implementer|tester|reviewer)/u)?.[1] ?? "unknown";
}

async function inspectRuntime(containerName, gpuIndex, served, localEndpoint, executables) {
  for (const name of ["podman", "nvidia-smi", "ss"]) assertExecutableUnchanged(name);
  const runtimeEnv = isolatedRuntimeEnv();
  const inspected = JSON.parse(execFileSync(executables.podman.path, ["inspect", containerName],
    { encoding: "utf8", env: runtimeEnv }))[0];
  const gpuDevices = (inspected?.HostConfig?.Devices ?? []).map((item) => item.PathOnHost)
    .filter((path) => /^\/dev\/nvidia\d+$/u.test(path)).sort();
  const rows = execFileSync(executables["nvidia-smi"].path, ["--query-gpu=index,uuid,name,memory.used,memory.total",
    "--format=csv,noheader,nounits"], { encoding: "utf8", env: runtimeEnv }).trim().split(/\r?\n/u)
    .map((line) => line.split(",").map((value) => value.trim()));
  const row = rows.find((item) => Number(item[0]) === gpuIndex);
  if (!row) throw new Error(`GPU ${gpuIndex} is not visible to nvidia-smi`);
  const version = await fetch(`${endpoint.replace(/\/v1\/?$/u, "")}/version`).then(async (response) => {
    if (!response.ok) throw new Error(`runtime version failed: HTTP ${response.status}`);
    return response.json();
  });
  const command = inspected?.Config?.Cmd ?? [];
  const hostPort = localEndpoint.port || "80"; const containerPort = command[command.indexOf("--port") + 1];
  const portBinding = (inspected?.NetworkSettings?.Ports?.[`${containerPort}/tcp`] ?? [])
    .find((item) => item.HostPort === hostPort && ["127.0.0.1", "::1"].includes(item.HostIp));
  const socket = execFileSync(executables.ss.path, ["-H", "-ltnp", `sport = :${hostPort}`],
    { encoding: "utf8", env: runtimeEnv });
  const listenerPid = Number(socket.match(/pid=(\d+)/u)?.[1]);
  const listenerCommand = Number.isSafeInteger(listenerPid)
    ? readFileSync(`/proc/${listenerPid}/cmdline`, "utf8").replaceAll("\0", " ") : "";
  const sandboxKey = inspected?.NetworkSettings?.SandboxKey ?? "";
  const endpointBound = Boolean(portBinding && sandboxKey && listenerCommand.includes(sandboxKey));
  if (!endpointBound) throw new Error("loopback endpoint is not bound to the declared Podman container network namespace");
  const image = JSON.parse(execFileSync(executables.podman.path, ["image", "inspect", inspected.Image],
    { encoding: "utf8", env: runtimeEnv }))[0];
  const modelEvidence = inspectModelSnapshot(inspected, served.root);
  const visibleRows = execFileSync(executables.podman.path, ["exec", containerName, "nvidia-smi",
    "--query-gpu=index,uuid,name,memory.used,memory.total", "--format=csv,noheader,nounits"],
    { encoding: "utf8", env: runtimeEnv }).trim().split(/\r?\n/u).filter(Boolean)
    .map((line) => line.split(",").map((value) => value.trim()));
  if (inspected?.HostConfig?.Privileged === true || visibleRows.length !== 1 || visibleRows[0]?.[1] !== row[1]) {
    throw new Error("container must be non-privileged and expose exactly the declared GPU UUID");
  }
  return { container: { name: containerName, id: inspected.Id, image: inspected.ImageName,
    imageId: image.Id, imageDigest: image.Digest, repoDigests: image.RepoDigests ?? [],
    privileged: inspected.HostConfig.Privileged === true, gpuDevices, command },
  endpointBinding: { bound: true, host: localEndpoint.hostname, hostPort: Number(hostPort),
    containerPort: Number(containerPort), listenerPid, networkNamespace: sandboxKey },
  server: { implementation: "vllm", version: version.version, servedRoot: served.root }, model: modelEvidence,
  gpu: { index: Number(row[0]), uuid: row[1], name: row[2], memoryUsedMiB: Number(row[3]), memoryTotalMiB: Number(row[4]),
    containerVisible: visibleRows.map((visible) => ({ index: Number(visible[0]), uuid: visible[1], name: visible[2],
      memoryUsedMiB: Number(visible[3]), memoryTotalMiB: Number(visible[4]) })) } };
}

function inspectModelSnapshot(inspected, servedRoot) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(servedRoot)) {
    throw new Error("served model root is not a pinned Hugging Face repository identity");
  }
  const cacheMount = (inspected?.Mounts ?? []).find((item) => item.Destination === "/root/.cache/huggingface");
  if (!cacheMount?.Source) throw new Error("container does not expose a host-bound Hugging Face cache");
  const repository = join(realpathSync(cacheMount.Source), "hub", `models--${servedRoot.replace("/", "--")}`);
  const snapshotRevision = readFileSync(join(repository, "refs", "main"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/u.test(snapshotRevision)) throw new Error("model snapshot revision is unavailable");
  const snapshot = realpathSync(join(repository, "snapshots", snapshotRevision));
  const entries = []; const pending = [snapshot];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const relative = relativePath(snapshot, path).replaceAll("\\", "/");
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) { pending.push(path); continue; }
      const target = realpathSync(path); const targetStat = statSync(target);
      entries.push({ path: relative, blob: relativePath(repository, target).replaceAll("\\", "/"), bytes: targetStat.size });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { repository: servedRoot, snapshotRevision, snapshotManifestDigest: sha256Text(JSON.stringify(entries)),
    snapshotFileCount: entries.length, snapshotBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`required executable is unavailable: ${name}`);
}

function assertExecutableUnchanged(name) {
  const pin = trustedExecutables[name];
  if (!pin || sha256(pin.path) !== pin.sha256) throw new Error(`trusted executable changed: ${name}`);
}

function isolatedRuntimeEnv() {
  const env = {};
  for (const name of ["HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "TMPDIR"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function validateLoopbackEndpoint(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.username || url.password
    || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("NAIA_LOCAL_OPENAI_BASE_URL must be credential-free loopback HTTP");
  }
  return url;
}

async function startEvidenceProxy(upstreamBase, calls) {
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bodyBytes = Buffer.concat(chunks); const requestBody = bodyBytes.length ? JSON.parse(bodyBytes.toString("utf8")) : undefined;
      const upstream = await fetch(`${upstreamBase.replace(/\/$/u, "")}${request.url.replace(/^\/v1/u, "")}`, {
        method: request.method, headers: bodyBytes.length ? { "content-type": "application/json" } : undefined,
        body: bodyBytes.length ? bodyBytes : undefined,
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      if (request.url.endsWith("/chat/completions") && responseBytes.length) captureToolCalls(
        responseBytes.toString("utf8"), upstream.headers.get("content-type") ?? "", requestBody, calls);
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      response.end(responseBytes);
    } catch (error) { response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })); }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("evidence proxy did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

async function probeLongContext(baseUrl, selectedModel) {
  const payload = { model: selectedModel, messages: [{ role: "user", content: `Return OK. ${"x ".repeat(40_000)}` }],
    max_tokens: 1, temperature: 0, stream: false };
  const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`>=32K context probe failed: HTTP ${response.status} ${await response.text()}`);
  const result = await response.json(); const promptTokens = Number(result.usage?.prompt_tokens);
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 32_768) throw new Error("context probe did not consume >=32K tokens");
  return { requestedRepeatedTerms: 40_000, promptTokens, completionTokens: Number(result.usage?.completion_tokens ?? 0),
    responseModel: result.model, responseId: result.id };
}

function captureToolCalls(text, contentType, requestBody, calls) {
  const declaredTools = (requestBody?.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
  if (contentType.includes("text/event-stream") || text.startsWith("data:")) {
    const pending = new Map(); let responseId; let responseModel; let finishReason;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
      const payload = JSON.parse(line.slice(5).trim()); responseId ??= payload.id; responseModel ??= payload.model;
      for (const choice of payload.choices ?? []) {
        finishReason = choice.finish_reason ?? finishReason;
        for (const delta of choice.delta?.tool_calls ?? []) {
          const index = Number(delta.index ?? 0); const current = pending.get(index) ?? { name: "", arguments: "" };
          current.name += delta.function?.name ?? ""; current.arguments += delta.function?.arguments ?? ""; pending.set(index, current);
        }
      }
    }
    for (const current of pending.values()) calls.push({ responseId, model: responseModel, finishReason,
      declaredTools, name: current.name, arguments: redactToolArguments(JSON.parse(current.arguments || "{}")) });
    return;
  }
  const payload = JSON.parse(text);
  for (const choice of payload.choices ?? []) for (const call of choice.message?.tool_calls ?? []) calls.push({
    responseId: payload.id, model: payload.model, finishReason: choice.finish_reason, declaredTools,
    name: call.function?.name, arguments: redactToolArguments(JSON.parse(call.function?.arguments ?? "{}")) });
}

function redactToolArguments(value) {
  const out = {}; for (const [key, item] of Object.entries(value)) {
    if (["path", "file_path", "query", "pattern"].includes(key) && typeof item === "string") out[key] = item;
    else if (key === "content" && typeof item === "string") out.contentSha256 = sha256Text(item);
    else out[key] = typeof item === "string" ? `[redacted:${item.length}]` : item;
  } return out;
}

function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sha256Text(value) { return createHash("sha256").update(value).digest("hex"); }

function collectTypescriptClosure(roots) {
  const pending = [...roots]; const visited = new Set();
  while (pending.length) {
    const relative = pending.pop(); if (visited.has(relative)) continue;
    const absolute = join(repositoryRoot, relative); if (!existsSync(absolute)) throw new Error(`source missing: ${relative}`);
    visited.add(relative); const source = ts.createSourceFile(relative, readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text; if (!specifier.startsWith(".")) continue;
      const base = resolve(join(repositoryRoot, relative, ".."), specifier);
      const target = [base.replace(/\.js$/u, ".ts"), `${base}.ts`, join(base, "index.ts")].find(existsSync);
      if (!target) throw new Error(`unresolved import from ${relative}: ${specifier}`);
      pending.push(relativePath(repositoryRoot, target).replaceAll("\\", "/"));
    }
  }
  return [...visited].sort();
}

function verifyExecutedDist(paths, distRoot) {
  const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(join(repositoryRoot, "tsconfig.json"), "utf8")), ts.sys, repositoryRoot);
  const mismatches = []; const executedArtifacts = {};
  for (const sourcePath of paths) {
    const emitted = ts.transpileModule(readFileSync(join(repositoryRoot, sourcePath), "utf8"),
      { compilerOptions: config.options, fileName: sourcePath }).outputText;
    const runtimePath = sourcePath.replace(/^src\//u, "").replace(/\.ts$/u, ".js");
    const absolute = join(distRoot, runtimePath); if (!existsSync(absolute)) throw new Error(`dist missing: ${runtimePath}`);
    if (readFileSync(absolute, "utf8") !== emitted) mismatches.push(runtimePath);
    executedArtifacts[runtimePath] = sha256(absolute);
  }
  return { exact: mismatches.length === 0, mismatches, executedArtifacts };
}
