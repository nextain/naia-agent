// Service manifest loader — pure parse + validate + memory-binding resolve.
//
// R6/SB-1 (issue #32, matrix §D50). The manifest is a *naia-adk workspace
// data file*, NOT a Part-A runtime contract: the host (naia-agent CLI, A.4)
// reads it and assembles the existing HostContext (llm / memory / persona-
// as-system). No new top-level contract is introduced.
//
// SoT for the schema + compat rules:
//   naia-adk/docs/service-manifest-schema.md (v0.1.0)
// Design SoT:
//   naia-adk/.agents/progress/agent-service-builder-architecture.md v4 §2/§6
//
// This module is pure (zero provider / naia-memory dependency) so the
// schema validator is unit-testable inside @nextain/agent-runtime's vitest
// (S02) without spawning the bin or hitting a network (G15). Concrete
// LLMClient construction stays host-side in bin/naia-agent.ts (mirrors the
// zero-runtime-dep posture of create-host.ts, matrix A.3).

import { isIP } from "node:net";

import type { ErrorEvent, MemoryProvider } from "@nextain/agent-types";
import { InMemoryMemory } from "../mocks/in-memory-memory.js";

/**
 * Highest manifest schema MAJOR this loader understands. A manifest whose
 * `schemaVersion` MAJOR exceeds this is rejected (MANIFEST_INVALID). A higher
 * MINOR/PATCH within the same MAJOR is forward-compatible: unknown additive
 * fields are ignored (schema §3, Part A.5 "shape 고정, 필드 추가 허용").
 */
export const SUPPORTED_MANIFEST_MAJOR = 0;

/**
 * v0.1.0 (SB-1) shape. RAG (`rag`), eval (`eval`) and orchestration
 * (`orchestration`) are deliberately absent — they land additively in
 * SB-2/SB-3/SB-4 (schema §1 호환표). Unknown extra fields are tolerated for
 * forward-compat and simply not consumed by this loader.
 */
export interface ServiceManifest {
  /** Document version, e.g. "0.1.0". Required. */
  schemaVersion: string;
  /** Service identifier (kebab-case recommended). Required. */
  name: string;
  /** Optional one-line human description. */
  description?: string;
  /** → Agent system message. Required. */
  persona: {
    /** Injected verbatim as the Agent system prompt. Required. */
    systemPrompt: string;
  };
  /** → HostContext.llm (D44 Vercel adapter). Required. */
  llm: {
    /** Provider id, e.g. "openai-compatible" | "anthropic" | "vertex". */
    backend: string;
    /** Model id, e.g. "Qwen/Qwen3.6-27B-FP8". */
    model: string;
    /** openai-compatible endpoint. Secrets/keys NEVER here — host env only
     *  (schema §4, 4-repo plan A.6). */
    baseURL?: string;
  };
  /** → HostContext.memory. Required. */
  memory: {
    /** "alpha-memory" | "in-memory" | "none". */
    binding: string;
  };
}

/** Discriminated parse result. `error` is a canonical Part-A.11 ErrorEvent. */
export type ManifestParseResult =
  | { ok: true; manifest: ServiceManifest }
  | { ok: false; error: ErrorEvent };

/**
 * Builds the canonical MANIFEST_INVALID ErrorEvent (design §5, Part A.11).
 * The contract field is `errorCode` (camelCase) — the design prose's
 * `error_code` is shorthand for this same @nextain/agent-types contract.
 *
 * Exported so host code (e.g. the CLI's unreadable-manifest path) emits the
 * IDENTICAL canonical shape — no hand-rolled drift (cross-review r4, codex
 * MEDIUM: a hand-built variant omitted the contract `timestamp`).
 */
export function manifestInvalid(detail: string): ErrorEvent {
  return {
    name: "error.manifest",
    timestamp: Date.now(),
    errorCode: "MANIFEST_INVALID",
    severity: "error",
    retryable: false,
    data: { detail },
    debug: detail,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const SEMVER_CORE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parses + validates a service manifest from raw JSON text.
 *
 * Fail-fast: the first violation produces a MANIFEST_INVALID ErrorEvent
 * whose `data.detail` names the offending field. Never throws.
 */
export function parseServiceManifest(raw: string): ManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: manifestInvalid(`invalid JSON: ${(e as Error).message}`) };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: manifestInvalid("manifest root must be a JSON object") };
  }

  // schemaVersion + compat (schema §3)
  const sv = parsed["schemaVersion"];
  if (!nonEmptyString(sv)) {
    return { ok: false, error: manifestInvalid("schemaVersion is required (semver string)") };
  }
  const m = SEMVER_CORE.exec(sv);
  if (!m) {
    return { ok: false, error: manifestInvalid(`schemaVersion "${sv}" is not semver (MAJOR.MINOR.PATCH)`) };
  }
  const major = Number(m[1]);
  if (major > SUPPORTED_MANIFEST_MAJOR) {
    return {
      ok: false,
      error: manifestInvalid(
        `unsupported schemaVersion "${sv}" (loader supports MAJOR ≤ ${SUPPORTED_MANIFEST_MAJOR})`,
      ),
    };
  }

  // name — STRICT kebab slug. Enforced (not merely recommended like the
  // schema prose) because `name` flows into a host filesystem path for the
  // alpha-memory binding; a lax value enables path traversal (e.g.
  // "../../../tmp/x"). Security review SB-1 Vuln 2.
  const name = parsed["name"];
  if (!nonEmptyString(name)) {
    return { ok: false, error: manifestInvalid("name is required (non-empty string)") };
  }
  if (name.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return {
      ok: false,
      error: manifestInvalid(
        `name "${name}" must be kebab-case (^[a-z0-9][a-z0-9-]*$, ≤64 chars) — ` +
          `no path separators or "." (it is used in a host-side filesystem path)`,
      ),
    };
  }

  // description (optional)
  const description = parsed["description"];
  if (description !== undefined && typeof description !== "string") {
    return { ok: false, error: manifestInvalid("description must be a string when present") };
  }

  // persona.systemPrompt
  const persona = parsed["persona"];
  if (!isPlainObject(persona) || !nonEmptyString(persona["systemPrompt"])) {
    return {
      ok: false,
      error: manifestInvalid("persona.systemPrompt is required (non-empty string)"),
    };
  }

  // llm.backend / llm.model / llm.baseURL?
  const llm = parsed["llm"];
  if (!isPlainObject(llm)) {
    return { ok: false, error: manifestInvalid("llm is required (object)") };
  }
  if (!nonEmptyString(llm["backend"])) {
    return { ok: false, error: manifestInvalid("llm.backend is required (non-empty string)") };
  }
  if (!nonEmptyString(llm["model"])) {
    return { ok: false, error: manifestInvalid("llm.model is required (non-empty string)") };
  }
  if (llm["baseURL"] !== undefined && typeof llm["baseURL"] !== "string") {
    return { ok: false, error: manifestInvalid("llm.baseURL must be a string when present") };
  }

  // memory.binding
  const memory = parsed["memory"];
  if (!isPlainObject(memory) || !nonEmptyString(memory["binding"])) {
    return {
      ok: false,
      error: manifestInvalid("memory.binding is required (non-empty string)"),
    };
  }

  const manifest: ServiceManifest = {
    schemaVersion: sv,
    name,
    persona: { systemPrompt: persona["systemPrompt"] as string },
    llm: {
      backend: llm["backend"] as string,
      model: llm["model"] as string,
      ...(typeof llm["baseURL"] === "string" ? { baseURL: llm["baseURL"] } : {}),
    },
    memory: { binding: memory["binding"] as string },
    ...(typeof description === "string" ? { description } : {}),
  };
  return { ok: true, manifest };
}

/**
 * Factory the host injects to build the "alpha-memory" binding. Kept as an
 * injected dependency so this module stays zero-dep on @nextain/naia-memory
 * (heavy footprint) and the validator/replay tests run without it.
 */
export type AlphaMemoryFactory = () => Promise<MemoryProvider>;

/**
 * Resolves a manifest `memory.binding` string to a MemoryProvider.
 *
 * - "in-memory" → InMemoryMemory (runtime mock)
 * - "none"      → InMemoryMemory (SB-1 minimal: for the single-shot CLI a
 *                 fresh InMemoryMemory recalls nothing, so it is functionally
 *                 a no-memory service. A dedicated NoopMemory is deferred
 *                 until session persistence makes the distinction observable.)
 * - "alpha-memory" → host-injected `alphaMemoryFactory()` (naia-memory).
 *                 Throws if the host did not provide one.
 * - anything else → throws (host surfaces as a usage error).
 */
export async function resolveMemoryBinding(
  binding: string,
  deps?: { alphaMemoryFactory?: AlphaMemoryFactory },
): Promise<MemoryProvider> {
  switch (binding) {
    case "in-memory":
    case "none":
      return new InMemoryMemory();
    case "alpha-memory": {
      if (!deps?.alphaMemoryFactory) {
        throw new Error(
          'memory.binding "alpha-memory" requires a host-provided alphaMemoryFactory',
        );
      }
      return deps.alphaMemoryFactory();
    }
    default:
      throw new Error(`unknown memory.binding "${binding}"`);
  }
}

/**
 * Trust gate for a manifest-supplied openai-compatible `llm.baseURL`.
 *
 * The manifest is untrusted (schema §4) but the host env carries the LLM API
 * key; letting a manifest point the client at an arbitrary remote host would
 * exfiltrate that key (the openai-compatible client sends it as a Bearer
 * header). Security review SB-1 Vuln 1.
 *
 * Also rejects http(s)-only violations and embedded userinfo credentials
 * (schema §4 — no secrets in the manifest; also avoids leaking them to logs).
 *
 * Pure (env is passed in, never read here, never written) so every host
 * (CLI / naia-os / naia-business-adk) applies the *same* gate and it is
 * unit-testable. A baseURL is trusted only if its host is loopback/private
 * (the SB-1 use case = local naia-model-infra vLLM) OR explicitly opted in
 * by the operator via NAIA_ALLOW_MANIFEST_BASEURL_HOSTS (comma-separated).
 */
export function manifestBaseURLTrust(
  baseURL: string,
  env: { NAIA_ALLOW_MANIFEST_BASEURL_HOSTS?: string | undefined },
): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return { ok: false, reason: `llm.baseURL "${baseURL}" is not a valid URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `llm.baseURL protocol "${url.protocol}" not allowed (http/https only)`,
    };
  }
  // Reject embedded credentials (userinfo). The manifest carries no secrets
  // (schema §4); a `user:pass@host` baseURL would also leak verbatim into
  // host stderr logs (cross-review r3, codex NEW — credential disclosure).
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason:
        `llm.baseURL must not embed credentials (userinfo) — ` +
        `schema §4: the manifest carries no secrets`,
    };
  }
  const rawHost = url.hostname;
  // Strip IPv6 brackets so net.isIP() can classify.
  const host = rawHost.replace(/^\[/, "").replace(/\]$/, "");
  if (isImplicitlyLocalHost(host)) return { ok: true };
  // Not loopback/private — require an explicit operator opt-in. Match the
  // host EXACTLY (cross-review r1: prefix matching let "10.0.0.5.evil.com"
  // pass and reopened the key-exfil vector).
  const allow = (env.NAIA_ALLOW_MANIFEST_BASEURL_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (allow.includes(rawHost) || allow.includes(host)) return { ok: true };
  return {
    ok: false,
    reason:
      `llm.baseURL host "${rawHost}" is not loopback/private and not in ` +
      `NAIA_ALLOW_MANIFEST_BASEURL_HOSTS — refusing (untrusted manifest could ` +
      `exfiltrate the host env API key; schema §4)`,
  };
}

/**
 * True only for loopback/private/link-local addresses, classified from the
 * PARSED ip family — never string prefixes. Cross-review r1 (codex MAJOR):
 * `/^10\./` etc. matched DNS names like "10.0.0.5.evil.com", reopening the
 * credential-exfil vector. A non-IP host is trusted only if it is exactly
 * "localhost" (no suffix tricks, no decimal/hex integer IPs).
 */
function isImplicitlyLocalHost(host: string): boolean {
  const fam = isIP(host);
  if (fam === 4) {
    const o = host.split(".").map((n) => Number(n));
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = o as [number, number, number, number];
    return (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8 private
      (a === 192 && b === 168) || // 192.168.0.0/16 private
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local
      o.every((n) => n === 0) // 0.0.0.0
    );
  }
  if (fam === 6) {
    const h = host.toLowerCase();
    return h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80:"); // loopback / ULA / link-local
  }
  // fam === 0 → a DNS hostname, not an IP literal. Only exact "localhost".
  return host.toLowerCase() === "localhost";
}
