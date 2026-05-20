// OS-keychain secret store — device-key-encrypted credential storage.
//
// naia-agent must NEVER persist an API key in plaintext (user hard line;
// cleanroom deep-audit F8/§128: OS keychain required, plaintext forbidden).
// Slice B backend = libsecret (`secret-tool`), which stores into the
// Secret Service (gnome-keyring / KWallet-via-ksecretd) — encrypted at
// rest with the user's login (device) key.
//
// Dependency-light by design: spawns the `secret-tool` CLI (no native
// addon — avoids the keytar/better-sqlite3 native-build pain). If the
// keychain is unavailable there is **NO plaintext fallback**: callers must
// refuse to persist and tell the user to use an env var instead.
//
// General — platform-detected, no model/tier/profile awareness.

import { spawnSync } from "node:child_process";

const SERVICE = "naia-agent";

// Force C locale so any (future) string inspection is deterministic and the
// gate is not localized. The real soundness comes from classifyProbe.
const C_ENV = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };

/**
 * Locale-INDEPENDENT availability classification (cross-review BLOCK fix):
 * classify SUCCESS, never localized error text. The absent-key probe on a
 * HEALTHY Secret Service is the only state that yields exit 1 with empty
 * stderr; exit 0 = found (also healthy). Anything else — spawn error,
 * timeout-kill (status null), or ANY non-empty stderr (a down/broken
 * service prints a connection/DBus error in the user's locale) — is
 * unavailable. Pure + exported so it is unit-tested against real measured
 * (incl. non-English) fixtures without touching a keychain.
 */
export function classifyProbe(r: {
  error?: unknown;
  status: number | null;
  stderr: string;
}): boolean {
  if (r.error || r.status === null) return false; // binary missing / killed
  if (r.status === 0) return true; // found → service healthy
  if (r.status === 1 && r.stderr.trim() === "") return true; // absent key, healthy
  return false; // any non-empty stderr / other status = unhealthy
}

export interface SecretStore {
  /** Backend reachable (binary present AND Secret Service responding). */
  available(): boolean;
  /** Retrieve a secret by ref name; undefined if absent/unavailable. */
  get(name: string): string | undefined;
  /** Store (device-key encrypted). Returns false if not stored. */
  set(name: string, value: string): boolean;
}

/** libsecret (`secret-tool`) backend — Linux Secret Service. */
class LibSecretStore implements SecretStore {
  #cached?: boolean;

  available(): boolean {
    if (this.#cached !== undefined) return this.#cached;
    // Probe a guaranteed-absent key; classify on SUCCESS (locale-safe).
    const r = spawnSync(
      "secret-tool",
      ["lookup", "service", SERVICE, "account", "__naia_probe_absent__"],
      { encoding: "utf8", timeout: 5000, env: C_ENV },
    );
    this.#cached = classifyProbe({ error: r.error, status: r.status, stderr: r.stderr ?? "" });
    return this.#cached;
  }

  get(name: string): string | undefined {
    const r = spawnSync(
      "secret-tool",
      ["lookup", "service", SERVICE, "account", name],
      { encoding: "utf8", timeout: 5000, env: C_ENV },
    );
    if (r.error || r.status !== 0) return undefined;
    const out = r.stdout ?? "";
    // secret-tool prints the secret with no trailing newline; guard anyway.
    return out.length > 0 ? out.replace(/\n$/, "") : undefined;
  }

  set(name: string, value: string): boolean {
    if (!this.available()) return false;
    const r = spawnSync(
      "secret-tool",
      ["store", "--label", `${SERVICE}: ${name}`, "service", SERVICE, "account", name],
      { input: value, encoding: "utf8", timeout: 5000, env: C_ENV },
    );
    return !r.error && r.status === 0;
  }
}

/** No-op store for platforms without a wired backend (available()=false). */
class NullSecretStore implements SecretStore {
  available(): boolean {
    return false;
  }
  get(): undefined {
    return undefined;
  }
  set(): boolean {
    return false;
  }
}

let singleton: SecretStore | undefined;

/**
 * Process-wide secret store. libsecret on Linux; NullSecretStore elsewhere
 * (Slice B scope = Linux Secret Service; macOS/Windows backends are a
 * follow-on — they degrade to "unavailable", never to plaintext).
 */
export function getSecretStore(): SecretStore {
  if (singleton) return singleton;
  singleton = process.platform === "linux" ? new LibSecretStore() : new NullSecretStore();
  return singleton;
}

/** Test seam — inject a fake store (reset with no arg). */
export function __setSecretStoreForTest(s?: SecretStore): void {
  singleton = s;
}
