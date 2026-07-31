// Shared first-class CLI host utilities. All secret persistence is OS-backed:
// Windows DPAPI(CurrentUser), Linux secret-tool. Plaintext ~/.naia-agent/.env is legacy read/migrate only.
import process from "node:process";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  credentialNameForProvider,
  parseCliConfig,
  removeEnvLines,
  serializeCliConfig,
} from "../dist/main/app/cli-manage.js";

export const CLI_HOME = join(homedir(), ".naia-agent");
export const CONFIG_PATH = join(CLI_HOME, "config.json");
export const LEGACY_ENV_PATH = join(CLI_HOME, ".env");

export function readText(path) {
  try { return fs.readFileSync(path, "utf8"); } catch { return null; }
}

export function readGlobalConfig() {
  return parseCliConfig(readText(CONFIG_PATH));
}

export function atomicWrite(path, content, mode = 0o600) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temp, content, { encoding: "utf8", mode });
  try { fs.chmodSync(temp, mode); } catch { /* Windows */ }
  fs.renameSync(temp, path);
}

export function resolveWorkspace(config = readGlobalConfig()) {
  return process.env.NAIA_ADK_PATH || config.adkPath || join(homedir(), "naia-adk");
}

export function workspaceCliConfigPath(workspace = resolveWorkspace()) {
  return join(workspace, "naia-settings", "cli.json");
}

/** Global config owns only the workspace pointer; coding defaults live with the workspace SoT. */
export function readCliConfig() {
  const global = readGlobalConfig();
  const workspace = resolveWorkspace(global);
  const local = parseCliConfig(readText(workspaceCliConfigPath(workspace)));
  return { ...global, ...(local.coding ? { coding: local.coding } : {}) };
}

export function writeGlobalConfig(config) {
  const { coding: _coding, ...global } = config;
  atomicWrite(CONFIG_PATH, serializeCliConfig(global));
}

export function writeWorkspaceCliConfig(config, workspace = resolveWorkspace(config)) {
  const current = parseCliConfig(readText(workspaceCliConfigPath(workspace)));
  const next = { ...current };
  if (config.coding && Object.keys(config.coding).length) next.coding = config.coding;
  else delete next.coding;
  atomicWrite(workspaceCliConfigPath(workspace), serializeCliConfig(next));
}

function parseLegacyEnv() {
  const out = new Map();
  const text = readText(LEGACY_ENV_PATH);
  if (!text) return out;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) out.set(name, value);
  }
  return out;
}

function dpapiPath(workspace, name) {
  return join(workspace, "naia-settings", ".keys", `${name}.dpapi`);
}

function readDpapi(workspace, name) {
  const file = dpapiPath(workspace, name);
  if (!fs.existsSync(file)) return undefined;
  const script = "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:DPAPI_FILE), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8", timeout: 8000, env: { ...process.env, DPAPI_FILE: file },
  });
  if (result.error || result.status !== 0) return undefined;
  return (result.stdout ?? "").replace(/\r?\n$/, "") || undefined;
}

function writeDpapi(workspace, name, secret) {
  const target = dpapiPath(workspace, name);
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${name}.${process.pid}.${randomUUID()}.tmp`);
  const script = "Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($v); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllBytes($env:DPAPI_FILE,$p)";
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    input: secret, encoding: "utf8", timeout: 8000, env: { ...process.env, DPAPI_FILE: temp },
  });
  if (result.error || result.status !== 0 || !fs.existsSync(temp)) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    return { ok: false, error: "Windows DPAPI 저장에 실패했습니다" };
  }
  fs.renameSync(temp, target);
  return { ok: true };
}

function secretToolRead(name) {
  const result = spawnSync("secret-tool", ["lookup", "service", "naia-agent", "account", name], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (result.error || result.status !== 0) return undefined;
  return (result.stdout ?? "").replace(/\n$/, "") || undefined;
}

export function readCredential(provider, config = readCliConfig()) {
  const name = credentialNameForProvider(provider);
  if (!name) return { present: false, source: "unsupported" };
  const aliases = provider === "naia" || provider === "nextain"
    ? [name, "NAIA_API_KEY"]
    : provider === "glm" || provider === "zai" ? [name, "ZHIPUAI_API_KEY"] : [name];
  for (const alias of aliases) {
    if (process.env[alias]) return { present: true, source: "environment", value: process.env[alias], name };
  }
  const workspace = resolveWorkspace(config);
  const stored = process.platform === "win32" ? readDpapi(workspace, name)
    : process.platform === "linux" ? secretToolRead(name) : undefined;
  if (stored) return { present: true, source: process.platform === "win32" ? "dpapi" : "secret-tool", value: stored, name };
  const legacy = parseLegacyEnv();
  for (const alias of aliases) {
    if (legacy.has(alias)) return { present: true, source: "legacy-env", value: legacy.get(alias), name };
  }
  return { present: false, source: process.platform === "darwin" ? "unsupported-platform" : "none", name };
}

export function writeCredential(provider, secret, config = readCliConfig()) {
  const name = credentialNameForProvider(provider);
  if (!name) return { ok: false, error: `지원하지 않는 provider: ${provider}` };
  let result;
  if (process.platform === "win32") {
    result = writeDpapi(resolveWorkspace(config), name, secret);
  } else if (process.platform === "linux") {
    const child = spawnSync("secret-tool", ["store", "--label", `naia-agent ${provider}`, "service", "naia-agent", "account", name], {
      input: secret, encoding: "utf8", timeout: 8000, env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    result = child.error || child.status !== 0 ? { ok: false, error: "Linux secret-tool 저장에 실패했습니다" } : { ok: true };
  } else {
    result = { ok: false, error: `이 플랫폼(${process.platform})의 OS credential store는 아직 지원하지 않습니다` };
  }
  if (!result.ok) return result;
  const legacy = readText(LEGACY_ENV_PATH);
  if (legacy !== null) {
    const names = provider === "naia" || provider === "nextain"
      ? [name, "NAIA_API_KEY"] : provider === "glm" || provider === "zai" ? [name, "ZHIPUAI_API_KEY"] : [name];
    const next = removeEnvLines(legacy, names);
    if (next) atomicWrite(LEGACY_ENV_PATH, next);
    else {
      try { fs.unlinkSync(LEGACY_ENV_PATH); } catch { /* already absent */ }
    }
  }
  return { ok: true, name };
}

export function deleteCredential(provider, config = readCliConfig()) {
  const name = credentialNameForProvider(provider);
  if (!name) return { ok: false, error: `지원하지 않는 provider: ${provider}` };
  if (process.platform === "win32") {
    try { fs.unlinkSync(dpapiPath(resolveWorkspace(config), name)); } catch (error) {
      if (error?.code !== "ENOENT") return { ok: false, error: "Windows DPAPI credential 삭제에 실패했습니다" };
    }
  } else if (process.platform === "linux") {
    const child = spawnSync("secret-tool", ["clear", "service", "naia-agent", "account", name], {
      encoding: "utf8", timeout: 8000, env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (child.error || ![0, 1].includes(child.status)) return { ok: false, error: "Linux secret-tool credential 삭제에 실패했습니다" };
  } else return { ok: false, error: `이 플랫폼(${process.platform})의 OS credential store는 아직 지원하지 않습니다` };
  const legacy = readText(LEGACY_ENV_PATH);
  if (legacy !== null) {
    const aliases = provider === "naia" || provider === "nextain" ? [name, "NAIA_API_KEY"] : [name];
    const next = removeEnvLines(legacy, aliases);
    if (next) atomicWrite(LEGACY_ENV_PATH, next);
    else { try { fs.unlinkSync(LEGACY_ENV_PATH); } catch { /* absent */ } }
  }
  return { ok: true, name };
}

/** Load only into this process; child isolation remains subagent-pi's responsibility. */
export function loadCredentialIntoProcess(provider, config = readCliConfig()) {
  const found = readCredential(provider, config);
  if (!found.present || !found.value) return found;
  const name = found.name;
  if (name && process.env[name] === undefined) process.env[name] = found.value;
  if ((provider === "naia" || provider === "nextain") && process.env.NAIA_API_KEY === undefined) process.env.NAIA_API_KEY = found.value;
  if ((provider === "glm" || provider === "zai") && process.env.ZHIPUAI_API_KEY === undefined) process.env.ZHIPUAI_API_KEY = found.value;
  return found;
}

export function validateWorkspaceValue(value) {
  return isAbsolute(value) ? null : "workspace는 절대경로여야 합니다";
}
