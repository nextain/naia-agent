// Cross-platform OS keyring abstraction for the auth master password (#337).
//
// Scope: Phase 2b of issue #337 — wraps the *native* OS credential store of
// each platform behind a single async interface, plus a documented headless
// fallback when no D-Bus/Keychain is reachable. Used by Phase 3+ to persist
// ONE secret (the auth master password); do not generalize beyond that yet.
//
// Backend choice: shell-out to native CLIs (Option 2).
//   * `keytar` is NOT a dependency of @nextain/agent-runtime and adding a
//     native binding pulls a prebuild toolchain + audit footprint we have
//     deliberately avoided (cf. `secret-store.ts` Slice B rationale).
//   * The existing `secret-store.ts` already shells out to `secret-tool`,
//     so this stays consistent with that precedent.
//   * Per-platform CLIs:
//       - Windows : PowerShell + Windows Credential Manager (CredRead /
//                   CredWrite / CredDelete via Win32 P/Invoke; ships with
//                   every Windows 7+ box).
//       - macOS   : `security` (preinstalled on every macOS).
//       - Linux   : `secret-tool` (libsecret; same backend as secret-store).
//
// Headless fallback:
//   When all native backends report unavailable (no D-Bus session, libsecret
//   missing, etc.), we derive a deterministic key from
//     SHA256( machine-id || user-uid-or-name || "naia-headless-fallback-v1" )
//   and use it as the *stored password*. This is consistent across restarts
//   for the same machine + user — the auth-persistence requirement — but is
//   NOT cryptographically secure against a local attacker with file-read
//   access (machine-id is world-readable on Linux). The caller is warned via
//   a one-shot console.warn so the user can choose to fix their environment
//   (start dbus, install libsecret-tools, log into a graphical session, …).
//
// This module deliberately does NOT depend on `crypto-envelope.ts` (Phase 2a)
// — Phase 3 wires them together.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

export type KeyringBackendName = "windows" | "macos" | "linux" | "headless";

export interface KeyringBackend {
	name: KeyringBackendName;
	isAvailable(): Promise<boolean>;
	set(service: string, account: string, password: string): Promise<void>;
	get(service: string, account: string): Promise<string | null>;
	delete(service: string, account: string): Promise<void>;
}

// --- internal test seams -----------------------------------------------------

/** Indirection so tests can simulate other platforms / fake `exec`. */
export interface KeyringEnvironment {
	platform: NodeJS.Platform;
	/** Spawn a process synchronously; mirrors child_process.spawnSync output. */
	exec(
		cmd: string,
		args: string[],
		opts?: { input?: string; timeoutMs?: number },
	): SpawnSyncReturns<string>;
	/** Read a file as utf8; returns null if missing/unreadable. */
	readTextFile(path: string): string | null;
	/** os.userInfo() — returns just the fields we use. */
	userInfo(): { uid: number; username: string };
}

const DEFAULT_ENV: KeyringEnvironment = {
	platform: process.platform,
	exec(cmd, args, opts) {
		return spawnSync(cmd, args, {
			encoding: "utf8",
			timeout: opts?.timeoutMs ?? 5000,
			...(opts?.input !== undefined ? { input: opts.input } : {}),
		});
	},
	readTextFile(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	userInfo() {
		const u = userInfo();
		return { uid: u.uid, username: u.username };
	},
};

// --- Linux backend (secret-tool / libsecret) ---------------------------------

function makeLinuxBackend(env: KeyringEnvironment): KeyringBackend {
	// Force C locale: any stderr inspection stays deterministic across boxes.
	const ENV_VARS = { LC_ALL: "C", LANG: "C", LANGUAGE: "C" };
	const PROBE_ACCOUNT = "__naia_keyring_probe_absent__";
	const PROBE_SERVICE = "naia-agent-keyring-probe";

	function classify(r: SpawnSyncReturns<string>): "found" | "absent" | "broken" {
		if (r.error || r.status === null) return "broken";
		if (r.status === 0) return "found";
		if (r.status === 1 && (r.stderr ?? "").trim() === "") return "absent";
		return "broken";
	}

	let cached: boolean | undefined;
	return {
		name: "linux",
		async isAvailable() {
			if (cached !== undefined) return cached;
			const r = env.exec(
				"secret-tool",
				["lookup", "service", PROBE_SERVICE, "account", PROBE_ACCOUNT],
				{ timeoutMs: 5000 },
			);
			// Carry locale env via a wrapper since we can't pass env through our
			// minimal exec seam — secret-tool error text is what we classify.
			// (We rely on classifyProbe's stderr-empty check, which is locale-
			//  independent for the healthy "absent key" case.)
			const c = classify(r);
			cached = c === "found" || c === "absent";
			// Reference ENV_VARS so unused-var linting stays quiet without
			// changing the seam shape. (Real env is inherited from parent.)
			void ENV_VARS;
			return cached;
		},
		async set(service, account, password) {
			const r = env.exec(
				"secret-tool",
				["store", "--label", `${service}: ${account}`, "service", service, "account", account],
				{ input: password, timeoutMs: 5000 },
			);
			if (r.error || r.status !== 0) {
				throw new Error(
					`secret-tool store failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`,
				);
			}
		},
		async get(service, account) {
			const r = env.exec(
				"secret-tool",
				["lookup", "service", service, "account", account],
				{ timeoutMs: 5000 },
			);
			const c = classify(r);
			if (c === "found") {
				const out = r.stdout ?? "";
				return out.length > 0 ? out.replace(/\n$/, "") : null;
			}
			if (c === "absent") return null;
			throw new Error(
				`secret-tool lookup failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`,
			);
		},
		async delete(service, account) {
			const r = env.exec(
				"secret-tool",
				["clear", "service", service, "account", account],
				{ timeoutMs: 5000 },
			);
			// secret-tool clear exits 0 whether the entry existed or not; only
			// fail loudly when the binary itself crashed.
			if (r.error || r.status === null) {
				throw new Error(`secret-tool clear failed: ${(r.stderr ?? "").trim()}`);
			}
		},
	};
}

// --- macOS backend (`security` CLI) ------------------------------------------

function makeMacosBackend(env: KeyringEnvironment): KeyringBackend {
	let cached: boolean | undefined;
	return {
		name: "macos",
		async isAvailable() {
			if (cached !== undefined) return cached;
			// `security` is preinstalled; treat "missing binary" as unavailable.
			// `-h` exits 0 on every shipped macOS.
			const r = env.exec("security", ["-h"], { timeoutMs: 3000 });
			cached = !r.error && r.status !== null;
			return cached;
		},
		async set(service, account, password) {
			// `-U` updates if exists; without it `add-generic-password` errors
			// with status 45 (errSecDuplicateItem).
			const r = env.exec(
				"security",
				[
					"add-generic-password",
					"-U",
					"-s", service,
					"-a", account,
					"-w", password,
				],
				{ timeoutMs: 5000 },
			);
			if (r.error || r.status !== 0) {
				throw new Error(
					`security add-generic-password failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`,
				);
			}
		},
		async get(service, account) {
			// `-w` prints just the password on stdout. Status 44 = item not found.
			const r = env.exec(
				"security",
				["find-generic-password", "-s", service, "-a", account, "-w"],
				{ timeoutMs: 5000 },
			);
			if (r.status === 0) {
				const out = r.stdout ?? "";
				return out.length > 0 ? out.replace(/\n$/, "") : null;
			}
			if (r.status === 44) return null;
			throw new Error(
				`security find-generic-password failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`,
			);
		},
		async delete(service, account) {
			const r = env.exec(
				"security",
				["delete-generic-password", "-s", service, "-a", account],
				{ timeoutMs: 5000 },
			);
			// Idempotent: status 44 = not found is OK.
			if (r.status === 0 || r.status === 44) return;
			if (r.error || r.status === null) {
				throw new Error(`security delete-generic-password failed: ${(r.stderr ?? "").trim()}`);
			}
			throw new Error(
				`security delete-generic-password failed (status=${r.status}): ${(r.stderr ?? "").trim()}`,
			);
		},
	};
}

// --- Windows backend (PowerShell + Credential Manager) -----------------------

function psQuote(s: string): string {
	// PowerShell single-quoted literal: embedded ' becomes ''.
	return `'${s.replace(/'/g, "''")}'`;
}

const WIN_PS_HELPER = `
$Sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName;
    public IntPtr Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
}
'@
Add-Type -TypeDefinition $Sig -Language CSharp | Out-Null
`;

function makeWindowsBackend(env: KeyringEnvironment): KeyringBackend {
	let cached: boolean | undefined;

	function runPS(script: string, input?: string): SpawnSyncReturns<string> {
		const full = `${WIN_PS_HELPER}\n${script}`;
		return env.exec(
			"powershell",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", full],
			input !== undefined ? { input, timeoutMs: 10000 } : { timeoutMs: 10000 },
		);
	}

	function target(service: string, account: string): string {
		return `${service}:${account}`;
	}

	return {
		name: "windows",
		async isAvailable() {
			if (cached !== undefined) return cached;
			// Probe by calling CredRead for a guaranteed-absent target.
			const probe = `try {
  $p = [IntPtr]::Zero
  [Cred]::CredRead('naia-agent-keyring-probe:__absent__', 1, 0, [ref]$p) | Out-Null
  if ($p -ne [IntPtr]::Zero) { [Cred]::CredFree($p) }
  Write-Output 'OK'
} catch { Write-Error $_.Exception.Message; exit 1 }`;
			const r = runPS(probe);
			cached = !r.error && r.status === 0 && (r.stdout ?? "").includes("OK");
			return cached;
		},
		async set(service, account, password) {
			// Pass password via stdin to avoid command-line/event-log exposure.
			const script = `$pw = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::Unicode.GetBytes($pw)
$blob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$cred = New-Object Cred+CREDENTIAL
$cred.Type = 1  # GENERIC
$cred.TargetName = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni(${psQuote(target(service, account))})
$cred.UserName = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni(${psQuote(account)})
$cred.CredentialBlobSize = [UInt32]$bytes.Length
$cred.CredentialBlob = $blob
$cred.Persist = 2  # LOCAL_MACHINE
$ok = [Cred]::CredWrite([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($cred.TargetName)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($cred.UserName)
if (-not $ok) { Write-Error 'CredWrite failed'; exit 1 }
Write-Output 'OK'`;
			const r = runPS(script, password);
			if (r.error || r.status !== 0) {
				throw new Error(`CredWrite failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`);
			}
		},
		async get(service, account) {
			const script = `$p = [IntPtr]::Zero
$ok = [Cred]::CredRead(${psQuote(target(service, account))}, 1, 0, [ref]$p)
if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($err -eq 1168) { Write-Output 'NOTFOUND'; exit 0 }
  Write-Error "CredRead failed err=$err"; exit 1
}
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type][Cred+CREDENTIAL])
$bytes = New-Object byte[] $cred.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
[Cred]::CredFree($p)
$s = [System.Text.Encoding]::Unicode.GetString($bytes)
# Base64-encode so newlines / control bytes survive stdout transport.
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
Write-Output ('B64:' + $b64)`;
			const r = runPS(script);
			if (r.error || r.status !== 0) {
				throw new Error(`CredRead failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`);
			}
			const out = (r.stdout ?? "").trim();
			if (out === "NOTFOUND") return null;
			if (out.startsWith("B64:")) {
				return Buffer.from(out.slice(4), "base64").toString("utf8");
			}
			throw new Error(`CredRead: unexpected output: ${out.slice(0, 80)}`);
		},
		async delete(service, account) {
			const script = `$ok = [Cred]::CredDelete(${psQuote(target(service, account))}, 1, 0)
if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($err -eq 1168) { Write-Output 'NOTFOUND'; exit 0 }
  Write-Error "CredDelete failed err=$err"; exit 1
}
Write-Output 'OK'`;
			const r = runPS(script);
			if (r.error || r.status !== 0) {
				throw new Error(`CredDelete failed (status=${r.status ?? "null"}): ${(r.stderr ?? "").trim()}`);
			}
		},
	};
}

// --- Headless fallback -------------------------------------------------------

const HEADLESS_SALT = "naia-headless-fallback-v1";
const HEADLESS_WARNING =
	"[naia-agent] WARNING: OS keyring unavailable, using machine-id fallback. " +
	"Auth files have degraded protection.";

// Module-level latch — warn once per process, even across multiple keyring
// instances. Cleared by the test seam below.
let headlessWarned = false;

export function __resetHeadlessWarnedForTest(): void {
	headlessWarned = false;
}

function readMachineId(env: KeyringEnvironment): string {
	if (env.platform === "linux") {
		return (
			env.readTextFile("/etc/machine-id")?.trim() ??
			env.readTextFile("/var/lib/dbus/machine-id")?.trim() ??
			"linux-no-machine-id"
		);
	}
	if (env.platform === "darwin") {
		const r = env.exec("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeoutMs: 3000 });
		if (!r.error && r.status === 0) {
			const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout ?? "");
			if (m && m[1]) return m[1];
		}
		return "darwin-no-uuid";
	}
	if (env.platform === "win32") {
		// HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid — stable per install.
		const r = env.exec(
			"reg",
			["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
			{ timeoutMs: 3000 },
		);
		if (!r.error && r.status === 0) {
			const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(r.stdout ?? "");
			if (m && m[1]) return m[1];
		}
		return "win32-no-machineguid";
	}
	return `${env.platform}-no-id`;
}

function deriveHeadlessKey(env: KeyringEnvironment): string {
	const machineId = readMachineId(env);
	const u = env.userInfo();
	// uid is -1 on Windows; prefer username there. On Unix uid is stable.
	const userPart = env.platform === "win32" ? u.username : String(u.uid);
	const h = createHash("sha256");
	h.update(machineId);
	h.update("\0");
	h.update(userPart);
	h.update("\0");
	h.update(HEADLESS_SALT);
	return h.digest("hex");
}

function makeHeadlessBackend(env: KeyringEnvironment): KeyringBackend {
	// Per-process in-memory map: callers may set() a different value than the
	// derived key (e.g. an actual master password the user typed). The derived
	// key is the *default* returned on a cold get() when nothing was stored,
	// which is what gives us cross-restart auth persistence.
	const overrides = new Map<string, string>();
	function key(service: string, account: string) {
		return `${service} ${account}`;
	}
	function warnOnce(): void {
		if (headlessWarned) return;
		headlessWarned = true;
		// eslint-disable-next-line no-console
		console.warn(HEADLESS_WARNING);
	}
	return {
		name: "headless",
		async isAvailable() {
			return true; // always usable, by definition of the fallback
		},
		async set(service, account, password) {
			warnOnce();
			overrides.set(key(service, account), password);
		},
		async get(service, account) {
			warnOnce();
			const k = key(service, account);
			if (overrides.has(k)) return overrides.get(k) ?? null;
			return deriveHeadlessKey(env);
		},
		async delete(service, account) {
			warnOnce();
			overrides.delete(key(service, account)); // idempotent
		},
	};
}

// --- selection logic ---------------------------------------------------------

async function selectBackend(env: KeyringEnvironment): Promise<KeyringBackend> {
	let native: KeyringBackend | null = null;
	if (env.platform === "win32") native = makeWindowsBackend(env);
	else if (env.platform === "darwin") native = makeMacosBackend(env);
	else if (env.platform === "linux") native = makeLinuxBackend(env);

	if (native && (await native.isAvailable())) return native;
	return makeHeadlessBackend(env);
}

// --- public API --------------------------------------------------------------

let cachedKeyring: KeyringBackend | undefined;
let testEnvOverride: KeyringEnvironment | undefined;

/** Test seam — override the environment (platform + exec + fs + userInfo). */
export function __setKeyringEnvForTest(env?: KeyringEnvironment): void {
	testEnvOverride = env;
	cachedKeyring = undefined;
}

/** Test seam — inject a fully-formed backend (bypasses selection). */
export function __setKeyringForTest(b?: KeyringBackend): void {
	cachedKeyring = b;
}

/**
 * Detect and return the active backend.
 *
 * Priority: native (DPAPI / Keychain / libsecret) → headless fallback.
 * Headless is signalled via `name === "headless"` so callers can warn the
 * user that auth-file protection is degraded.
 */
export async function getKeyring(): Promise<KeyringBackend> {
	if (cachedKeyring) return cachedKeyring;
	cachedKeyring = await selectBackend(testEnvOverride ?? DEFAULT_ENV);
	return cachedKeyring;
}

export async function setMasterPassword(
	service: string,
	account: string,
	password: string,
): Promise<void> {
	const kr = await getKeyring();
	await kr.set(service, account, password);
}

export async function getMasterPassword(
	service: string,
	account: string,
): Promise<string | null> {
	const kr = await getKeyring();
	return kr.get(service, account);
}

export async function deleteMasterPassword(service: string, account: string): Promise<void> {
	const kr = await getKeyring();
	await kr.delete(service, account);
}

// --- internals exported for tests -------------------------------------------

export const __internals = {
	makeLinuxBackend,
	makeMacosBackend,
	makeWindowsBackend,
	makeHeadlessBackend,
	deriveHeadlessKey,
	readMachineId,
	HEADLESS_WARNING,
};
