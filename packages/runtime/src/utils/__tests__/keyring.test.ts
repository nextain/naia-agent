// Tests for the cross-platform OS keyring abstraction (#337 Phase 2b).
//
// Real OS keyring calls require an actual logged-in user with a working
// keychain / Credential Manager / Secret Service, which we cannot assume on
// CI. So we cover:
//   1. Backend selection per simulated platform (mocked `exec`).
//   2. Round-trip set/get/delete on the headless backend (pure JS).
//   3. Determinism + machine-id sensitivity of the headless key.
//   4. One-shot console.warn for headless.
//   5. Idempotent delete on non-existent key (headless).
// The native shell-out paths are exercised indirectly via the selection logic
// — wired full round-trips against real OS tools are left to manual / opt-in
// integration runs (out of scope for this slice).

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__internals,
	__resetHeadlessWarnedForTest,
	__setKeyringEnvForTest,
	__setKeyringForTest,
	deleteMasterPassword,
	getKeyring,
	getMasterPassword,
	setMasterPassword,
	type KeyringEnvironment,
} from "../keyring.js";

function ok(stdout = "", status = 0): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: ["", stdout, ""],
		stdout,
		stderr: "",
		status,
		signal: null,
	} as SpawnSyncReturns<string>;
}

function fail(stderr = "boom", status = 1): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: ["", "", stderr],
		stdout: "",
		stderr,
		status,
		signal: null,
	} as SpawnSyncReturns<string>;
}

function spawnError(): SpawnSyncReturns<string> {
	return {
		pid: 0,
		output: ["", "", ""],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
		error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
	} as unknown as SpawnSyncReturns<string>;
}

/** Build a stub KeyringEnvironment with overridable parts. */
function makeEnv(partial: Partial<KeyringEnvironment>): KeyringEnvironment {
	return {
		platform: "linux",
		exec: () => ok(),
		readTextFile: () => null,
		userInfo: () => ({ uid: 1000, username: "luke" }),
		...partial,
	};
}

afterEach(() => {
	__setKeyringEnvForTest();
	__setKeyringForTest();
	__resetHeadlessWarnedForTest();
	vi.restoreAllMocks();
});

describe("backend selection — isAvailable reflects platform reality", () => {
	it("Linux + healthy secret-tool → linux backend", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "linux",
				// `secret-tool lookup` with no match exits 1 + empty stderr.
				exec: () => ok("", 1),
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("linux");
	});

	it("Linux + broken secret-tool → headless fallback", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "linux",
				exec: () => fail("secret-tool: cannot connect to dbus", 1),
				readTextFile: () => "deadbeef\n",
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("headless");
	});

	it("Linux + missing secret-tool binary → headless", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "linux",
				exec: () => spawnError(),
				readTextFile: () => "deadbeef\n",
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("headless");
	});

	it("macOS + working security CLI → macos backend", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "darwin",
				exec: () => ok("usage…"),
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("macos");
	});

	it("macOS + missing security CLI → headless", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "darwin",
				exec: () => spawnError(),
				userInfo: () => ({ uid: 501, username: "alice" }),
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("headless");
	});

	it("Windows + working PowerShell CredRead probe → windows backend", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "win32",
				exec: () => ok("OK\r\n"),
				userInfo: () => ({ uid: -1, username: "luke" }),
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("windows");
	});

	it("Windows + PowerShell error → headless", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "win32",
				exec: () => fail("access denied", 1),
				userInfo: () => ({ uid: -1, username: "luke" }),
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("headless");
	});

	it("unknown platform → headless directly", async () => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "freebsd" as NodeJS.Platform,
			}),
		);
		const kr = await getKeyring();
		expect(kr.name).toBe("headless");
	});
});

describe("getKeyring — all-native-unavailable simulation returns headless", () => {
	it.each<NodeJS.Platform>(["linux", "darwin", "win32"])(
		"%s with broken native tools → headless",
		async (platform) => {
			__setKeyringEnvForTest(
				makeEnv({
					platform,
					exec: () => spawnError(),
					readTextFile: () => "machine-id-stub",
					userInfo: () => ({ uid: 1000, username: "luke" }),
				}),
			);
			const kr = await getKeyring();
			expect(kr.name).toBe("headless");
			expect(await kr.isAvailable()).toBe(true);
		},
	);
});

describe("headless backend — round-trip set/get/delete", () => {
	beforeEach(() => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "freebsd" as NodeJS.Platform, // forces headless directly
				readTextFile: () => "fbsd-machine-id",
				userInfo: () => ({ uid: 1000, username: "luke" }),
			}),
		);
		// Silence the warn so test output stays clean; assertion-level tests
		// for the warn live in their own describe below.
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("set then get returns the stored value", async () => {
		await setMasterPassword("naia-auth", "default", "hunter2");
		expect(await getMasterPassword("naia-auth", "default")).toBe("hunter2");
	});

	it("get on never-set key returns the deterministic derived key (string)", async () => {
		const v = await getMasterPassword("naia-auth", "never-set");
		expect(v).toBeTypeOf("string");
		expect(v).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
	});

	it("set overrides the derived default", async () => {
		const derived = await getMasterPassword("naia-auth", "slot1");
		await setMasterPassword("naia-auth", "slot1", "custom-pw");
		expect(await getMasterPassword("naia-auth", "slot1")).toBe("custom-pw");
		expect(await getMasterPassword("naia-auth", "slot1")).not.toBe(derived);
	});

	it("delete is idempotent on non-existent key (no throw)", async () => {
		await expect(
			deleteMasterPassword("naia-auth", "never-was-set"),
		).resolves.toBeUndefined();
		// And a second time, also OK.
		await expect(
			deleteMasterPassword("naia-auth", "never-was-set"),
		).resolves.toBeUndefined();
	});

	it("delete after set removes the override (next get falls back to derived)", async () => {
		await setMasterPassword("naia-auth", "slotX", "custom");
		expect(await getMasterPassword("naia-auth", "slotX")).toBe("custom");
		await deleteMasterPassword("naia-auth", "slotX");
		const after = await getMasterPassword("naia-auth", "slotX");
		expect(after).toMatch(/^[0-9a-f]{64}$/);
		expect(after).not.toBe("custom");
	});
});

describe("headless derived key — determinism + machine-id sensitivity", () => {
	it("same machine + user → same hex across calls", async () => {
		const env = makeEnv({
			platform: "linux",
			readTextFile: () => "stable-machine-id\n",
			userInfo: () => ({ uid: 1000, username: "luke" }),
		});
		const a = __internals.deriveHeadlessKey(env);
		const b = __internals.deriveHeadlessKey(env);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("different machine-id → different hex", async () => {
		const envA = makeEnv({
			platform: "linux",
			readTextFile: () => "machine-A\n",
			userInfo: () => ({ uid: 1000, username: "luke" }),
		});
		const envB = makeEnv({
			platform: "linux",
			readTextFile: () => "machine-B\n",
			userInfo: () => ({ uid: 1000, username: "luke" }),
		});
		expect(__internals.deriveHeadlessKey(envA)).not.toBe(
			__internals.deriveHeadlessKey(envB),
		);
	});

	it("different user (uid on unix) → different hex", async () => {
		const env1 = makeEnv({
			platform: "linux",
			readTextFile: () => "same-machine\n",
			userInfo: () => ({ uid: 1000, username: "luke" }),
		});
		const env2 = makeEnv({
			platform: "linux",
			readTextFile: () => "same-machine\n",
			userInfo: () => ({ uid: 1001, username: "luke" }),
		});
		expect(__internals.deriveHeadlessKey(env1)).not.toBe(
			__internals.deriveHeadlessKey(env2),
		);
	});

	it("Linux falls back to /var/lib/dbus/machine-id when /etc/machine-id missing", () => {
		const env = makeEnv({
			platform: "linux",
			readTextFile: (p) => (p === "/var/lib/dbus/machine-id" ? "dbus-mid\n" : null),
			userInfo: () => ({ uid: 1000, username: "luke" }),
		});
		expect(__internals.readMachineId(env)).toBe("dbus-mid");
	});

	it("macOS uses ioreg IOPlatformUUID", () => {
		const env = makeEnv({
			platform: "darwin",
			exec: () =>
				ok(
					'  | |   "IOPlatformUUID" = "AAAA-BBBB-CCCC-DDDD"\n  | |   "IOPlatformSerialNumber" = "X"\n',
				),
		});
		expect(__internals.readMachineId(env)).toBe("AAAA-BBBB-CCCC-DDDD");
	});

	it("Windows reads MachineGuid from registry", () => {
		const env = makeEnv({
			platform: "win32",
			exec: () =>
				ok(
					"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    12345678-1234-1234-1234-1234567890ab\r\n\r\n",
				),
		});
		expect(__internals.readMachineId(env)).toBe(
			"12345678-1234-1234-1234-1234567890ab",
		);
	});

	it("Windows uses username (not -1 uid) in the derivation", () => {
		const envA = makeEnv({
			platform: "win32",
			exec: () =>
				ok("    MachineGuid    REG_SZ    same-guid\r\n"),
			userInfo: () => ({ uid: -1, username: "alice" }),
		});
		const envB = makeEnv({
			platform: "win32",
			exec: () =>
				ok("    MachineGuid    REG_SZ    same-guid\r\n"),
			userInfo: () => ({ uid: -1, username: "bob" }),
		});
		expect(__internals.deriveHeadlessKey(envA)).not.toBe(
			__internals.deriveHeadlessKey(envB),
		);
	});
});

describe("headless warning — emitted exactly once per process", () => {
	beforeEach(() => {
		__setKeyringEnvForTest(
			makeEnv({
				platform: "freebsd" as NodeJS.Platform,
				readTextFile: () => "mid",
				userInfo: () => ({ uid: 1000, username: "luke" }),
			}),
		);
	});

	it("emits the spec'd warning string exactly once across many calls", async () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await setMasterPassword("svc", "a", "p");
		await getMasterPassword("svc", "a");
		await getMasterPassword("svc", "b");
		await deleteMasterPassword("svc", "a");

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe(__internals.HEADLESS_WARNING);
	});

	it("resetting the latch makes the next op warn again (test-seam contract)", async () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await getMasterPassword("svc", "k");
		expect(spy).toHaveBeenCalledTimes(1);

		__resetHeadlessWarnedForTest();
		// Need a fresh backend so the in-memory override map isn't blocking.
		__setKeyringForTest();
		await getMasterPassword("svc", "k");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("macOS backend — set passes password via stdin (#337 codex #4)", () => {
	it("set uses stdin: argv ends with bare '-w', no trailing password, input=password", async () => {
		const calls: Array<{
			cmd: string;
			args: string[];
			opts: { input?: string; timeoutMs?: number } | undefined;
		}> = [];
		delete process.env.NAIA_KEYRING_MACOS_LEGACY_ARGV;
		__setKeyringEnvForTest(
			makeEnv({
				platform: "darwin",
				exec: (cmd, args, opts) => {
					calls.push({ cmd, args, opts });
					// First call is the `security -h` isAvailable probe.
					return ok("ok");
				},
			}),
		);

		await setMasterPassword("io.nextain.naia", "auth-master-v1", "super-secret-pw");

		// Find the add-generic-password invocation (skip the -h probe).
		const setCall = calls.find((c) => c.args[0] === "add-generic-password");
		expect(setCall, "expected an add-generic-password invocation").toBeDefined();
		const args = setCall!.args;
		// `-w` must be the final argument (no trailing password).
		expect(args[args.length - 1]).toBe("-w");
		// Password must NOT appear anywhere in argv.
		expect(args).not.toContain("super-secret-pw");
		// Password MUST be piped via stdin.
		expect(setCall!.opts?.input).toBe("super-secret-pw");
		// Sanity: -U / -s / -a / service / account still wired correctly.
		expect(args).toContain("-U");
		expect(args).toContain("-s");
		expect(args).toContain("io.nextain.naia");
		expect(args).toContain("-a");
		expect(args).toContain("auth-master-v1");
	});

	it("set throws when security CLI returns non-zero (stdin path)", async () => {
		delete process.env.NAIA_KEYRING_MACOS_LEGACY_ARGV;
		let nthCall = 0;
		__setKeyringEnvForTest(
			makeEnv({
				platform: "darwin",
				exec: () => {
					nthCall += 1;
					// 1st = -h probe (ok). 2nd = add-generic-password (fail).
					if (nthCall === 1) return ok("ok");
					return fail("write denied", 1);
				},
			}),
		);
		await expect(
			setMasterPassword("svc", "acct", "pw"),
		).rejects.toThrow(/security add-generic-password failed/);
	});

	it("NAIA_KEYRING_MACOS_LEGACY_ARGV=1 reverts to argv-based path", async () => {
		const calls: Array<{
			cmd: string;
			args: string[];
			opts: { input?: string; timeoutMs?: number } | undefined;
		}> = [];
		process.env.NAIA_KEYRING_MACOS_LEGACY_ARGV = "1";
		try {
			__setKeyringEnvForTest(
				makeEnv({
					platform: "darwin",
					exec: (cmd, args, opts) => {
						calls.push({ cmd, args, opts });
						return ok("ok");
					},
				}),
			);

			await setMasterPassword("svc", "acct", "legacy-pw");

			const setCall = calls.find((c) => c.args[0] === "add-generic-password");
			expect(setCall, "expected an add-generic-password invocation").toBeDefined();
			// Legacy path: password IS in argv (the documented escape hatch).
			expect(setCall!.args).toContain("legacy-pw");
			// And stdin is NOT used.
			expect(setCall!.opts?.input).toBeUndefined();
			// `-w` is not the final arg in legacy mode (password follows it).
			const wIdx = setCall!.args.indexOf("-w");
			expect(wIdx).toBeGreaterThanOrEqual(0);
			expect(setCall!.args[wIdx + 1]).toBe("legacy-pw");
		} finally {
			delete process.env.NAIA_KEYRING_MACOS_LEGACY_ARGV;
		}
	});
});

describe("public API helpers route through getKeyring", () => {
	it("setMasterPassword + getMasterPassword + deleteMasterPassword all go through the cached backend", async () => {
		const log: string[] = [];
		__setKeyringForTest({
			name: "headless",
			isAvailable: async () => true,
			set: async (s, a, p) => {
				log.push(`set ${s}/${a}=${p}`);
			},
			get: async (s, a) => {
				log.push(`get ${s}/${a}`);
				return "stub";
			},
			delete: async (s, a) => {
				log.push(`del ${s}/${a}`);
			},
		});
		await setMasterPassword("svc", "acct", "pw");
		const v = await getMasterPassword("svc", "acct");
		await deleteMasterPassword("svc", "acct");
		expect(v).toBe("stub");
		expect(log).toEqual([
			"set svc/acct=pw",
			"get svc/acct",
			"del svc/acct",
		]);
	});
});

// Real-OS smoke: run only on the matching platform AND when explicitly opted
// in (NAIA_KEYRING_LIVE=1) — guards against breaking unrelated CI runs.
const LIVE = process.env["NAIA_KEYRING_LIVE"] === "1";
describe.skipIf(!LIVE)("LIVE — real OS keyring round-trip (opt-in)", () => {
	const SERVICE = "naia-agent-test";
	const ACCOUNT = `phase2b-${Date.now()}`;
	const PASSWORD = "live-test-secret-" + Math.random().toString(36).slice(2);

	it("set → get → delete against the real backend", async () => {
		__setKeyringEnvForTest(); // use real env
		__setKeyringForTest();
		const kr = await getKeyring();
		// On a real headed box this should be native; if headless, that is
		// still acceptable (the contract).
		await kr.set(SERVICE, ACCOUNT, PASSWORD);
		expect(await kr.get(SERVICE, ACCOUNT)).toBe(PASSWORD);
		await kr.delete(SERVICE, ACCOUNT);
		// After delete: native backends return null, headless falls back to
		// the derived key. Either is acceptable.
		const after = await kr.get(SERVICE, ACCOUNT);
		expect(after === null || /^[0-9a-f]{64}$/.test(after)).toBe(true);
	});
});
