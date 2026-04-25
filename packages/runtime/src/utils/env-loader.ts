// Slice 1c — env + JSON config auto-loader (no dotenv dep, native parser).
//
// Resolution order (first match wins, populates process.env if unset):
//   1) process.env (existing — never overwritten)
//   2) CLI flag --env <path>
//   3) NAIA_AGENT_ENV env var
//   4) ./.env (cwd)
//   5) ./naia-agent.env (cwd, opinionated name)
//   6) ~/.naia-agent/.env (global)
//
// JSON config separate:
//   1) CLI flag --config <path>
//   2) NAIA_AGENT_CONFIG env var
//   3) ./.naia-agent.json (cwd)
//   4) ~/.naia-agent/config.json (global)
//
// Loaded JSON keys flatten into process.env if not already set (string values
// only — nested keys flattened with `_`, booleans/numbers stringified).
//
// Sources opted out of secrets-leak: never logs values, only key names.

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

import type { Logger } from "@nextain/agent-types";

export interface EnvLoadOptions {
  envPath?: string;
  configPath?: string;
  cwd?: string;
  logger?: Logger;
}

export interface EnvLoadReport {
  envFile?: string;
  configFile?: string;
  loadedKeys: string[];
}

const ENV_CANDIDATES = (cwd: string, explicit?: string): string[] => {
  const list: string[] = [];
  if (explicit) list.push(explicit);
  if (process.env["NAIA_AGENT_ENV"]) list.push(process.env["NAIA_AGENT_ENV"]);
  list.push(join(cwd, ".env"));
  list.push(join(cwd, "naia-agent.env"));
  list.push(join(HOME, ".naia-agent", ".env"));
  return list;
};

const CONFIG_CANDIDATES = (cwd: string, explicit?: string): string[] => {
  const list: string[] = [];
  if (explicit) list.push(explicit);
  if (process.env["NAIA_AGENT_CONFIG"]) list.push(process.env["NAIA_AGENT_CONFIG"]);
  list.push(join(cwd, ".naia-agent.json"));
  list.push(join(HOME, ".naia-agent", "config.json"));
  return list;
};

function isReadableFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Minimal .env parser. Supports:
 *   KEY=value
 *   KEY="quoted value"
 *   KEY='single-quoted value'
 *   # comments and blank lines ignored
 *   export KEY=value (export prefix stripped)
 * Does NOT support: variable interpolation, multi-line values.
 */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7) : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Recursively flatten JSON object → KEY_PATH_LIKE keys with string values.
 * Only top-level keys + 1-level nested objects supported (sufficient for env-style
 * config). Arrays serialized as JSON.
 */
/** Convert camelCase / kebab-case → SCREAMING_SNAKE_CASE. */
function toEnvKey(s: string): string {
  return s
    .replace(/[-]/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

export function flattenConfig(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const partKey = toEnvKey(k);
    const flatKey = prefix ? `${prefix}_${partKey}` : partKey;
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenConfig(v as Record<string, unknown>, flatKey));
    } else {
      out[flatKey] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return out;
}

export function loadEnvAndConfig(opts: EnvLoadOptions = {}): EnvLoadReport {
  const cwd = opts.cwd ?? process.cwd();
  const fn = opts.logger?.fn?.("loadEnvAndConfig", { cwd, envPath: opts.envPath, configPath: opts.configPath });
  const report: EnvLoadReport = { loadedKeys: [] };

  for (const candidate of ENV_CANDIDATES(cwd, opts.envPath)) {
    if (!candidate || !isReadableFile(candidate)) continue;
    try {
      const parsed = parseEnv(readFileSync(candidate, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
          report.loadedKeys.push(k);
        }
      }
      report.envFile = candidate;
      fn?.branch("env-loaded", { file: candidate, keys: Object.keys(parsed).length });
      break;
    } catch {
      // try next
    }
  }

  for (const candidate of CONFIG_CANDIDATES(cwd, opts.configPath)) {
    if (!candidate || !isReadableFile(candidate)) continue;
    try {
      const json = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      const flat = flattenConfig(json);
      for (const [k, v] of Object.entries(flat)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
          if (!report.loadedKeys.includes(k)) report.loadedKeys.push(k);
        }
      }
      report.configFile = candidate;
      fn?.branch("config-loaded", { file: candidate, keys: Object.keys(flat).length });
      break;
    } catch {
      // try next
    }
  }

  fn?.exit({ totalKeys: report.loadedKeys.length, envFile: report.envFile, configFile: report.configFile });
  return report;
}
