// naia-settings/llm.json reader — cross-repo LLM config (naia-adk ↔ naia-agent).
//
// The canonical (정본) 3-role LLM config lives at
//   <NAIA_ADK_PATH>/naia-settings/llm.json
// (fork-root, git-tracked backup unit). naia-agent CONSUMES it; it does not
// own the schema (SoT = naia-adk/naia-settings/README.md).
//
// Resolution priority (this module slots ABOVE the .env/json loaders, BELOW
// process.env):  process.env  >  naia-settings/llm.json  >  .env files
//
// `main` maps onto the EXISTING provider-resolution env keys (OPENAI_* /
// ANTHROPIC_* / GLM_*), so bin/naia-agent buildLLMClient() is unchanged
// (general — no per-model/tier branching; provider-driven only). `sub` /
// `embedded` are exposed as NAIA_SUB_* / NAIA_EMBED_* for their consumers.
//
// Secret policy: NO plaintext key in llm.json — `apiKeyRef` names an env
// var (Slice A) or an OS-keychain entry (Slice B). Local Ollama/vLLM need
// no key (a sentinel satisfies the openai-compat resolver). Values are
// never logged (key names only).

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "@nextain/agent-types";

export interface NaiaSettingsOptions {
  /** naia-adk workspace root. Defaults to process.env.NAIA_ADK_PATH. */
  adkPath?: string;
  logger?: Logger;
}

interface LLMRole {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKeyRef?: string;
  dims?: number;
}

interface LLMSettings {
  version?: number;
  main?: LLMRole;
  sub?: LLMRole;
  embedded?: LLMRole;
}

export interface NaiaSettingsReport {
  /** No adkPath / file absent → nothing done (env-only path still works). */
  skipped: boolean;
  file?: string;
  /** Provider per role that was found (names only, no secrets). */
  roles: { main?: string; sub?: string; embedded?: string };
  /** Env keys this loader populated (were unset). Names only. */
  setKeys: string[];
}

const KNOWN_VERSION = 1;

/** Resolve a secret by reference. Slice A: env-var name. (Slice B: OS keychain.) */
function resolveSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return process.env[ref];
}

function setIfUnset(key: string, value: string | undefined, out: string[]): void {
  if (value === undefined) return;
  if (process.env[key] === undefined) {
    process.env[key] = value;
    out.push(key);
  }
}

/** Map the `main` role onto the existing provider-resolution env keys. */
function applyMain(role: LLMRole, set: string[]): void {
  const p = (role.provider ?? "").toLowerCase();
  if (p === "openai-compat" || p === "openai-compatible" || p === "ollama" || p === "vllm") {
    setIfUnset("OPENAI_BASE_URL", role.baseUrl, set);
    setIfUnset("OPENAI_MODEL", role.model, set);
    // Local Ollama/vLLM ignore the key; a sentinel satisfies the resolver
    // (which requires OPENAI_API_KEY && OPENAI_BASE_URL). A real key, if
    // referenced and present, takes precedence.
    setIfUnset("OPENAI_API_KEY", resolveSecret(role.apiKeyRef) ?? "ollama", set);
  } else if (p === "anthropic") {
    setIfUnset("ANTHROPIC_MODEL", role.model, set);
    setIfUnset("ANTHROPIC_BASE_URL", role.baseUrl, set);
    // No sentinel — Anthropic needs a real key; absent → resolver falls
    // through honestly rather than failing opaquely.
    setIfUnset("ANTHROPIC_API_KEY", resolveSecret(role.apiKeyRef), set);
  } else if (p === "glm") {
    setIfUnset("GLM_MODEL", role.model, set);
    setIfUnset("GLM_BASE_URL", role.baseUrl, set);
    setIfUnset("GLM_API_KEY", resolveSecret(role.apiKeyRef), set);
  }
  // Unknown provider → recorded in report.roles.main, no env mapping
  // (resolver will report "no provider configured" — honest).
}

function applyAux(prefix: string, role: LLMRole, set: string[]): void {
  setIfUnset(`${prefix}_PROVIDER`, role.provider, set);
  setIfUnset(`${prefix}_BASE_URL`, role.baseUrl, set);
  setIfUnset(`${prefix}_MODEL`, role.model, set);
  if (role.dims !== undefined) setIfUnset(`${prefix}_DIMS`, String(role.dims), set);
}

/**
 * Load `<adkPath>/naia-settings/llm.json` and populate process.env (unset
 * keys only). Graceful: missing path/file → skip; malformed → warn + skip
 * (never crash the CLI). Never logs secret values.
 */
export function loadNaiaSettingsLLM(opts: NaiaSettingsOptions = {}): NaiaSettingsReport {
  const report: NaiaSettingsReport = { skipped: true, roles: {}, setKeys: [] };
  const adkPath = opts.adkPath ?? process.env["NAIA_ADK_PATH"];
  if (!adkPath) return report;

  const file = join(adkPath, "naia-settings", "llm.json");
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return report;
  } catch {
    return report;
  }

  let parsed: LLMSettings;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as LLMSettings;
  } catch (err) {
    opts.logger?.warn("naia-settings.parse.error", { file, err: String(err) });
    return report;
  }
  if (!parsed || typeof parsed !== "object" || (!parsed.main && !parsed.sub && !parsed.embedded)) {
    opts.logger?.warn("naia-settings.shape.invalid", { file });
    return report;
  }
  if (parsed.version !== undefined && parsed.version !== KNOWN_VERSION) {
    opts.logger?.warn("naia-settings.version.unknown", { file, version: parsed.version });
  }

  if (parsed.main) {
    applyMain(parsed.main, report.setKeys);
    if (parsed.main.provider) report.roles.main = parsed.main.provider;
  }
  if (parsed.sub) {
    applyAux("NAIA_SUB", parsed.sub, report.setKeys);
    if (parsed.sub.provider) report.roles.sub = parsed.sub.provider;
  }
  if (parsed.embedded) {
    applyAux("NAIA_EMBED", parsed.embedded, report.setKeys);
    if (parsed.embedded.provider) report.roles.embedded = parsed.embedded.provider;
  }

  report.skipped = false;
  report.file = file;
  opts.logger?.fn?.("loadNaiaSettingsLLM", { file })?.exit({
    roles: report.roles,
    setKeys: report.setKeys.length,
  });
  return report;
}
