#!/usr/bin/env node
// UC-023 / SPEC-019 first-class CLI management host.
// Pure grammar/policy lives in dist/main/app/cli-manage; this file owns fs/TTY/keychain/HTTP/process.
import process from "node:process";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_CONFIG_KEYS,
  FALLBACK_NAIA_MODELS,
  MANAGE_USAGE,
  SESSION_FILE_MAX_BYTES,
  credentialNameForProvider,
  getCliConfigValue,
  normalizeModelCatalog,
  parseManageArgs,
  parseTranscript,
  resetCliConfigValue,
  setCliConfigValue,
} from "../dist/main/app/cli-manage.js";
import { redactSecrets } from "../dist/main/adapters/redact.js";
import {
  CONFIG_PATH,
  deleteCredential,
  loadCredentialIntoProcess,
  readCliConfig,
  readCredential,
  resolveWorkspace,
  validateWorkspaceValue,
  workspaceCliConfigPath,
  writeGlobalConfig,
  writeWorkspaceCliConfig,
  writeCredential,
} from "./naia-agent-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = join(HERE, "naia-agent-chat.mjs");
const PROVIDERS = ["naia", "anthropic", "openai", "gemini", "glm", "xai"];

function exitError(message, code = 64) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    if (process.stdin.isTTY) exitError("현재 터미널은 hidden input을 지원하지 않습니다. stdin 또는 --key를 사용하세요.");
    let data = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise((resolve) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { cleanup(); resolve(value); return; }
        if (ch === "\u0003") { cleanup(); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch >= " ") value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function doAuth(args) {
  const config = readCliConfig();
  if (args.action === "status") {
    const providers = args.provider ? [args.provider] : PROVIDERS;
    const accounts = providers.map((provider) => {
      const status = readCredential(provider, config);
      return { provider, authenticated: status.present, source: status.source, credential: credentialNameForProvider(provider) };
    });
    if (args.json) process.stdout.write(`${JSON.stringify({ accounts }, null, 2)}\n`);
    else for (const item of accounts) process.stdout.write(`${item.provider.padEnd(12)} ${item.authenticated ? "logged-in" : "logged-out"}  (${item.source})\n`);
    return;
  }
  if (args.action === "login") {
    let key = args.key;
    if (key !== undefined) process.stderr.write("경고: --key 값은 셸 히스토리나 프로세스 목록에 노출될 수 있습니다.\n");
    else key = await hiddenPrompt(`${args.provider} API key: `);
    if (!key?.trim()) exitError("키가 비어 있습니다. 저장하지 않았습니다.");
    const saved = writeCredential(args.provider, key.trim(), config);
    if (!saved.ok) exitError(saved.error, 78);
    process.stderr.write(`✓ ${args.provider} 계정을 OS credential store에 저장했습니다 (${saved.name}).\n`);
    return;
  }
  const removed = deleteCredential(args.provider, config);
  if (!removed.ok) exitError(removed.error, 78);
  process.stderr.write(`✓ ${args.provider} 계정 credential을 제거했습니다.\n`);
}

function configObject(config) {
  return Object.fromEntries(CLI_CONFIG_KEYS.map((key) => [key, getCliConfigValue(config, key) ?? null]));
}

function doConfig(args) {
  const config = readCliConfig();
  if (args.action === "list") {
    const values = configObject(config);
    if (args.json) process.stdout.write(`${JSON.stringify({ config: values, paths: { global: CONFIG_PATH, workspace: workspaceCliConfigPath(resolveWorkspace(config)) } }, null, 2)}\n`);
    else for (const [key, value] of Object.entries(values)) process.stdout.write(`${key}=${value ?? "(unset)"}\n`);
    return;
  }
  if (args.action === "get") {
    const value = getCliConfigValue(config, args.key);
    if (args.json) process.stdout.write(`${JSON.stringify({ key: args.key, value: value ?? null })}\n`);
    else if (value !== undefined) process.stdout.write(`${String(value)}\n`);
    else process.exitCode = 1;
    return;
  }
  if (args.action === "set") {
    if (args.key === "workspace") {
      const error = validateWorkspaceValue(args.value);
      if (error) exitError(error);
    }
    const changed = setCliConfigValue(config, args.key, args.value);
    if (!changed.ok) exitError(changed.error);
    if (args.key === "workspace") writeGlobalConfig(changed.config);
    else writeWorkspaceCliConfig(changed.config, resolveWorkspace(config));
    process.stderr.write(`✓ ${args.key}=${String(getCliConfigValue(changed.config, args.key))}\n`);
    return;
  }
  const changed = resetCliConfigValue(config, args.key);
  if (!args.key) {
    writeWorkspaceCliConfig(changed, resolveWorkspace(config));
    writeGlobalConfig(changed);
  } else if (args.key === "workspace") writeGlobalConfig(changed);
  else writeWorkspaceCliConfig(changed, resolveWorkspace(config));
  process.stderr.write(`✓ ${args.key ?? "CLI 관리 설정"} reset\n`);
}

async function fetchModels() {
  const auth = loadCredentialIntoProcess("naia");
  if (!auth.present || !auth.value) return { models: FALLBACK_NAIA_MODELS, source: "fallback", warning: "Naia 계정이 없어 내장 Pi 목록을 표시합니다." };
  const base = (process.env.NAIA_API_BASE_URL || process.env.NAIA_ANYLLM_BASE_URL || "https://api.nextain.io").replace(/\/+$/, "").replace(/\/v1$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/v1/models`, {
      headers: { "X-AnyLLM-Key": `Bearer ${auth.value}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = normalizeModelCatalog(await response.json());
    if (!models.length) throw new Error("empty catalog");
    return { models, source: "live" };
  } catch (error) {
    return { models: FALLBACK_NAIA_MODELS, source: "fallback", warning: `live catalog 실패(${error instanceof Error ? error.message : String(error)}); 내장 Pi 목록 사용` };
  } finally { clearTimeout(timer); }
}

async function doModels(args) {
  const result = await fetchModels();
  const models = args.provider
    ? result.models.filter((model) => model.provider.toLowerCase() === args.provider || (args.provider === "naia" && ["azure", "nextain"].includes(model.provider.toLowerCase())))
    : result.models;
  if (args.json) process.stdout.write(`${JSON.stringify({ source: result.source, ...(result.warning ? { warning: result.warning } : {}), models }, null, 2)}\n`);
  else {
    if (result.warning) process.stderr.write(`경고: ${result.warning}\n`);
    for (const model of models) process.stdout.write(`${model.provider}/${model.id}\ttools=${model.tools ? "yes" : "no"}\tuse=${model.use}\n`);
  }
}

function sessionPath(workspace, id) {
  return join(workspace, "conversations", `${id}.jsonl`);
}

function readSession(workspace, id) {
  const path = sessionPath(workspace, id);
  const stat = fs.statSync(path);
  if (!stat.isFile()) throw new Error("session 파일이 아닙니다");
  if (stat.size > SESSION_FILE_MAX_BYTES) throw new Error(`session 파일이 ${SESSION_FILE_MAX_BYTES} byte 상한을 초과했습니다`);
  const raw = fs.readFileSync(path);
  if (raw.byteLength > SESSION_FILE_MAX_BYTES) throw new Error(`session 파일이 ${SESSION_FILE_MAX_BYTES} byte 상한을 초과했습니다`);
  const parsed = parseTranscript(raw.toString("utf8"));
  return {
    id, path, updatedAt: stat.mtimeMs, skipped: parsed.skipped, truncated: parsed.truncated,
    messages: parsed.messages.map((message) => ({ ...message, content: redactSecrets(message.content) })),
  };
}

function listSessions(workspace, limit) {
  const dir = join(workspace, "conversations");
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jsonl$/.test(entry.name))
    .map((entry) => {
      const id = entry.name.slice(0, -6);
      try {
        const stat = fs.statSync(join(dir, entry.name));
        if (stat.size > SESSION_FILE_MAX_BYTES) return { id, updatedAt: stat.mtimeMs, messages: null, status: "too-large" };
        const parsed = parseTranscript(fs.readFileSync(join(dir, entry.name), "utf8"), 20);
        const first = parsed.messages.find((message) => message.role === "user")?.content ?? "";
        return { id, updatedAt: stat.mtimeMs, messages: parsed.messages.length, title: redactSecrets(first).replace(/\s+/g, " ").slice(0, 60), status: parsed.skipped ? "partial" : "ok" };
      } catch { return { id, updatedAt: stat.mtimeMs, messages: null, status: "unreadable" }; }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

async function doSession(args) {
  const workspace = resolveWorkspace();
  if (args.action === "list") {
    const sessions = listSessions(workspace, args.limit);
    if (args.json) process.stdout.write(`${JSON.stringify({ workspace, sessions }, null, 2)}\n`);
    else for (const item of sessions) process.stdout.write(`${item.id}\t${new Date(item.updatedAt).toISOString()}\t${item.status}\t${item.title ?? ""}\n`);
    return;
  }
  if (args.action === "show") {
    let session;
    try { session = readSession(workspace, args.sessionId); } catch (error) { exitError(`session을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`, 66); }
    if (args.json) process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    else for (const message of session.messages) process.stdout.write(`${message.role}> ${message.content}\n`);
    return;
  }
  // Resume is delegated to the existing chat host and therefore uses the same composeAgentRuntimeDeps + wireAgentUC1.
  const child = spawn(process.execPath, [CHAT, "chat", "--resume", args.sessionId], { stdio: "inherit" });
  await new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 0; resolve();
    });
    child.on("error", (error) => { process.stderr.write(`session resume 실패: ${error.message}\n`); process.exitCode = 1; resolve(); });
  });
}

async function doDoctor(args) {
  const config = readCliConfig();
  const workspace = resolveWorkspace(config);
  const auth = readCredential("naia", config);
  const settings = join(workspace, "naia-settings", "config.json");
  const piCandidates = [
    join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    join(HERE, "..", "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi"),
  ];
  const catalog = await fetchModels();
  const checks = [
    { component: "account.naia", status: auth.present ? "pass" : "fail", detail: auth.present ? `source=${auth.source}` : "naia-agent auth login --provider naia 필요" },
    { component: "workspace", status: fs.existsSync(workspace) ? "pass" : "fail", detail: workspace },
    { component: "naia-settings", status: fs.existsSync(settings) ? "pass" : "warn", detail: fs.existsSync(settings) ? settings : "workspace naia-settings/config.json 없음" },
    { component: "pi", status: piCandidates.some((path) => fs.existsSync(path)) ? "pass" : "fail", detail: piCandidates.find((path) => fs.existsSync(path)) ?? "Pi executable/package 없음" },
    { component: "models", status: catalog.source === "live" ? "pass" : "warn", detail: catalog.source === "live" ? `${catalog.models.length} live models` : catalog.warning },
  ];
  const ready = !checks.some((check) => check.status === "fail");
  if (args.json) process.stdout.write(`${JSON.stringify({ ready, workspace, checks }, null, 2)}\n`);
  else {
    for (const check of checks) process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.component.padEnd(18)} ${check.detail}\n`);
    process.stdout.write(`\n${ready ? "READY" : "NOT READY"}\n`);
  }
  if (!ready) process.exitCode = 1;
}

const parsed = parseManageArgs(process.argv.slice(2));
if (!parsed.ok) {
  if (parsed.help) { process.stdout.write(`${parsed.error ?? MANAGE_USAGE}\n`); process.exit(0); }
  exitError(parsed.error);
}

const args = parsed.args;
if (args.command === "auth") await doAuth(args);
else if (args.command === "config") doConfig(args);
else if (args.command === "models") await doModels(args);
else if (args.command === "doctor") await doDoctor(args);
else await doSession(args);
