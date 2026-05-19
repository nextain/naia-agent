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
import { manifestBaseURLTrust } from "../host/service-manifest.js";
import { getSecretStore } from "./secret-store.js";

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

/**
 * Resolve a secret by reference name. `apiKeyRef` may name an env var
 * (process.env wins — highest priority / override) OR an OS-keychain entry
 * (device-key encrypted, Slice B). Never a plaintext value from llm.json.
 */
function resolveSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return process.env[ref] ?? getSecretStore().get(ref);
}

// llm.json is a git-tracked backup unit — it must carry NO raw secret, only
// `apiKeyRef`. The reader actively DEFENDS this invariant (not merely
// "doesn't read it"): a role with a secret-ish key (anything but apiKeyRef)
// or a value that looks like a raw credential → the whole file is rejected.
// cleanroom deep-audit F8/§128 ("plaintext forbidden") + user hard line.
const SECRETISH_KEY = /^(api[_-]?key|key|token|secret|password|passwd|pwd|bearer)$/i;
/** Raw-credential value heuristics — shared with the login WRITE path so a
 *  secret is rejected at the boundary, not only detected on later read. */
export const RAW_SECRET_VALUE = [
  /sk-[A-Za-z0-9_-]{8,}/, // incl. Anthropic sk-ant-api03-… (hyphenated)
  /AIza[0-9A-Za-z_-]{10,}/,
  /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9]/,
  /xox[baprs]-[A-Za-z0-9]/,
  /\bAKIA[0-9A-Z]{12,}/,
  /^[0-9a-f]{40,}$/i,
];

/** True if a role object contains a plaintext-secret-looking key or value. */
function roleHasPlaintextSecret(role: unknown): boolean {
  if (!role || typeof role !== "object") return false;
  for (const [k, v] of Object.entries(role as Record<string, unknown>)) {
    if (k.toLowerCase() !== "apikeyref" && SECRETISH_KEY.test(k)) return true;
    if (typeof v === "string" && RAW_SECRET_VALUE.some((re) => re.test(v))) return true;
  }
  return false;
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
    const refVal = resolveSecret(role.apiKeyRef);
    if (refVal !== undefined) {
      // Referenced key present → use it (real keyed remote).
      setIfUnset("OPENAI_API_KEY", refVal, set);
    } else if (
      role.apiKeyRef === undefined &&
      role.baseUrl !== undefined &&
      manifestBaseURLTrust(role.baseUrl, process.env).ok
    ) {
      // No key configured AND baseUrl is loopback/private (or operator
      // opt-in) → local Ollama/vLLM ignores the key; sentinel satisfies the
      // resolver. NOT applied to remote baseUrls (would send `Bearer ollama`
      // to a real host and fail opaquely) — reuses the general
      // manifestBaseURLTrust gate, no model sniffing.
      setIfUnset("OPENAI_API_KEY", "ollama", set);
    }
    // else: apiKeyRef present-but-unresolved, OR remote baseUrl w/o key →
    // no sentinel; resolver falls through honestly (symmetric w/ anthropic).
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
  // A configured sub/embedded apiKeyRef must reach its consumer (cross-
  // review F2: it was silently dropped → a remote embed/sub got no key).
  setIfUnset(`${prefix}_API_KEY`, resolveSecret(role.apiKeyRef), set);
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

  // Defend the no-plaintext-secret invariant (this file is git-tracked).
  // Reject the WHOLE file if any role carries a raw credential — fail safe,
  // never log the value (role name only).
  for (const r of ["main", "sub", "embedded"] as const) {
    if (roleHasPlaintextSecret(parsed[r])) {
      opts.logger?.warn("naia-settings.secret.plaintext_suspected", { file, role: r });
      return report; // skipped — do not consume a file with a plaintext key
    }
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
