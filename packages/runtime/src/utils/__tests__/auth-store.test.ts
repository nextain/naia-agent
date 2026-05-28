// Tests for the encrypted auth-file store (#337 Phase 3).
//
// Strategy:
//   * Each test gets a fresh tmpdir which becomes NAIA_ADK_PATH so file paths
//     don't collide across tests.
//   * The OS keyring is swapped out for a pure in-memory KeyringBackend via
//     the `__setKeyringForTest` seam from Phase 2b — tests never touch the
//     real DPAPI / Keychain / Secret Service.
//   * Module-level caches in auth-store (RW locks, master password) are
//     reset via `__resetAuthStoreForTest`.

import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptEnvelope } from "../crypto-envelope.js";
import {
	__setKeyringForTest,
	type KeyringBackend,
} from "../keyring.js";
import {
	__resetAuthStoreForTest,
	type AuthMode,
	type AuthState,
	deleteAuth,
	getAuthFilePath,
	getCurrentMode,
	loadAuth,
	saveAuth,
} from "../auth-store.js";

// --- in-memory keyring fixture ----------------------------------------------

function makeMemKeyring(): KeyringBackend & {
	store: Map<string, string>;
} {
	const store = new Map<string, string>();
	const k = (s: string, a: string) => `${s}\0${a}`;
	return {
		store,
		name: "headless",
		async isAvailable() {
			return true;
		},
		async set(service, account, password) {
			store.set(k(service, account), password);
		},
		async get(service, account) {
			return store.get(k(service, account)) ?? null;
		},
		async delete(service, account) {
			store.delete(k(service, account));
		},
	};
}

// --- env + tmpdir fixture ----------------------------------------------------

const ORIG_ADK_PATH = process.env.NAIA_ADK_PATH;
const ORIG_MODE = process.env.NAIA_AGENT_MODE;

let adkRoot: string;
let mem: ReturnType<typeof makeMemKeyring>;

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

function sampleState(mode: AuthMode, overrides: Partial<AuthState> = {}): AuthState {
	return {
		schema: 1,
		keyVersion: 1,
		mode,
		naiaKey: `gw-${mode}-key`,
		refreshToken: `rt-${mode}`,
		userId: "naia_user_42",
		issuer: mode === "dev" ? "http://localhost:3001" : "https://naia.nextain.io",
		scope: ["chat", "memory"],
		issuedAt: 1748400000,
		expiresAt: 1748403600,
		rotatedAt: null,
		...overrides,
	};
}

beforeEach(async () => {
	adkRoot = await mkdtemp(path.join(tmpdir(), "naia-auth-store-"));
	process.env.NAIA_ADK_PATH = adkRoot;
	delete process.env.NAIA_AGENT_MODE;
	mem = makeMemKeyring();
	__setKeyringForTest(mem);
	__resetAuthStoreForTest();
});

afterEach(async () => {
	__setKeyringForTest();
	__resetAuthStoreForTest();
	if (ORIG_ADK_PATH === undefined) delete process.env.NAIA_ADK_PATH;
	else process.env.NAIA_ADK_PATH = ORIG_ADK_PATH;
	if (ORIG_MODE === undefined) delete process.env.NAIA_AGENT_MODE;
	else process.env.NAIA_AGENT_MODE = ORIG_MODE;
	await rm(adkRoot, { recursive: true, force: true });
});

// --- tests -------------------------------------------------------------------

describe("getCurrentMode", () => {
	it("returns dev when NAIA_AGENT_MODE=dev", () => {
		process.env.NAIA_AGENT_MODE = "dev";
		expect(getCurrentMode()).toBe("dev");
	});

	it("returns prod when NAIA_AGENT_MODE=prod", () => {
		process.env.NAIA_AGENT_MODE = "prod";
		expect(getCurrentMode()).toBe("prod");
	});

	it("returns prod default when NAIA_AGENT_MODE is bogus", () => {
		process.env.NAIA_AGENT_MODE = "bogus";
		expect(getCurrentMode()).toBe("prod");
	});

	it("returns prod default when NAIA_AGENT_MODE is unset", () => {
		delete process.env.NAIA_AGENT_MODE;
		expect(getCurrentMode()).toBe("prod");
	});
});

describe("getAuthFilePath", () => {
	it("throws when NAIA_ADK_PATH is unset", () => {
		delete process.env.NAIA_ADK_PATH;
		expect(() => getAuthFilePath("prod")).toThrow(/NAIA_ADK_PATH not set/);
	});

	it("returns <ADK>/naia-settings/auth/{mode}.json.enc", () => {
		const p = getAuthFilePath("dev");
		expect(p).toBe(path.join(adkRoot, "naia-settings", "auth", "dev.json.enc"));
	});
});

describe("loadAuth / saveAuth round-trip", () => {
	it("cold boot — loadAuth on empty dir returns null", async () => {
		expect(await loadAuth("prod")).toBeNull();
	});

	it("save then load returns equal state", async () => {
		const state = sampleState("prod");
		await saveAuth(state);
		const loaded = await loadAuth("prod");
		expect(loaded).toEqual(state);
	});

	it("mode isolation — saving dev does not satisfy prod load", async () => {
		await saveAuth(sampleState("dev"));
		expect(await loadAuth("prod")).toBeNull();
		expect(await loadAuth("dev")).toEqual(sampleState("dev"));
	});
});

describe("master password bootstrap", () => {
	it("populates keyring on first saveAuth", async () => {
		expect(mem.store.size).toBe(0);
		await saveAuth(sampleState("prod"));
		expect(mem.store.size).toBe(1);
		const stored = mem.store.get("io.nextain.naia\0auth-master-v1");
		expect(stored).toBeTruthy();
		expect(stored!.length).toBe(64); // 32 random bytes = 64 hex chars
	});

	it("reuses keyring entry across saves", async () => {
		await saveAuth(sampleState("prod"));
		const first = mem.store.get("io.nextain.naia\0auth-master-v1");
		await saveAuth(sampleState("prod", { naiaKey: "gw-rotated" }));
		const second = mem.store.get("io.nextain.naia\0auth-master-v1");
		expect(second).toBe(first);
		expect(mem.store.size).toBe(1);
	});
});

describe("tamper + schema + mode rejection", () => {
	it("tampered ciphertext is rejected with an explicit error", async () => {
		await saveAuth(sampleState("prod"));
		const filePath = getAuthFilePath("prod");
		const blob = await readFile(filePath);
		// Flip a byte well inside the ciphertext (past the 49-byte header).
		const tampered = Buffer.from(blob);
		tampered[60] = (tampered[60]! ^ 0xff) & 0xff;
		await writeFile(filePath, tampered);
		await expect(loadAuth("prod")).rejects.toThrow(/Decryption failed/);
	});

	it("schema mismatch is rejected with an explicit error", async () => {
		// Bootstrap the master password first so we can encrypt our own blob.
		await saveAuth(sampleState("prod"));
		const masterPw = mem.store.get("io.nextain.naia\0auth-master-v1")!;
		const bad = {
			...sampleState("prod"),
			schema: 999,
		};
		const blob = await encryptEnvelope(
			new TextEncoder().encode(JSON.stringify(bad)),
			masterPw,
		);
		await writeFile(getAuthFilePath("prod"), blob);
		await expect(loadAuth("prod")).rejects.toThrow(/schema mismatch.*999/);
	});

	it("mode mismatch is rejected with an explicit error", async () => {
		await saveAuth(sampleState("prod"));
		const masterPw = mem.store.get("io.nextain.naia\0auth-master-v1")!;
		// Encrypt a blob whose payload says mode=dev but write it to prod's path.
		const evil = sampleState("dev");
		const blob = await encryptEnvelope(
			new TextEncoder().encode(JSON.stringify(evil)),
			masterPw,
		);
		await writeFile(getAuthFilePath("prod"), blob);
		await expect(loadAuth("prod")).rejects.toThrow(/mode mismatch.*prod.*dev/);
	});
});

describe("deleteAuth", () => {
	it("removes the file and load returns null", async () => {
		await saveAuth(sampleState("prod"));
		const filePath = getAuthFilePath("prod");
		expect(await fileExists(filePath)).toBe(true);

		await deleteAuth("prod");
		expect(await fileExists(filePath)).toBe(false);
		expect(await loadAuth("prod")).toBeNull();
	});

	it("is idempotent — deleting a non-existent file does not throw", async () => {
		// Directory does not even exist yet.
		await deleteAuth("prod");
	});
});

describe("atomic write", () => {
	it("a stale .tmp from a crashed write does not corrupt the existing file", async () => {
		// Write a valid auth file first.
		await saveAuth(sampleState("prod"));
		const filePath = getAuthFilePath("prod");
		const original = await readFile(filePath);

		// Simulate a crash: write garbage to <file>.tmp but never rename.
		await writeFile(`${filePath}.tmp`, Buffer.from("garbage"));

		// Original file is still readable + valid.
		const loaded = await loadAuth("prod");
		expect(loaded).toEqual(sampleState("prod"));
		expect(await readFile(filePath)).toEqual(original);
	});
});

describe("RW lock — concurrent reads + read-during-write", () => {
	it("10 concurrent reads all return the same state", async () => {
		await saveAuth(sampleState("prod"));
		const results = await Promise.all(
			Array.from({ length: 10 }, () => loadAuth("prod")),
		);
		for (const r of results) {
			expect(r).toEqual(sampleState("prod"));
		}
	});

	it("a read started during a slow write sees the post-write state", async () => {
		// Seed an initial blob, then start a write that's deliberately racing
		// with a read. We use a state V1 followed by V2; the concurrent reader
		// must observe V2 (post-write) and never partial state.
		await saveAuth(sampleState("prod", { naiaKey: "v1" }));

		const writePromise = saveAuth(sampleState("prod", { naiaKey: "v2" }));
		// Spawn a reader immediately while the writer holds the lock.
		const readPromise = loadAuth("prod");

		const [, loaded] = await Promise.all([writePromise, readPromise]);
		expect(loaded?.naiaKey).toBe("v2");
	});
});

describe("__resetAuthStoreForTest", () => {
	it("forgets the cached master password — next save re-reads from keyring", async () => {
		await saveAuth(sampleState("prod"));
		const firstPw = mem.store.get("io.nextain.naia\0auth-master-v1");
		expect(firstPw).toBeTruthy();

		// Reset module state. Cached master password is forgotten.
		__resetAuthStoreForTest();

		// saveAuth should now re-read from the keyring (and reuse the same
		// password, since the keyring still has it).
		await saveAuth(sampleState("prod"));
		expect(mem.store.get("io.nextain.naia\0auth-master-v1")).toBe(firstPw);
	});

	it("after reset + cleared keyring, saveAuth bootstraps a fresh password", async () => {
		await saveAuth(sampleState("prod"));
		const firstPw = mem.store.get("io.nextain.naia\0auth-master-v1");

		// Simulate full state loss: reset cache AND wipe keyring.
		__resetAuthStoreForTest();
		mem.store.clear();

		// Old file is unreadable now (no master password) → loadAuth returns null.
		expect(await loadAuth("prod")).toBeNull();

		// Next save generates a brand-new master password.
		await saveAuth(sampleState("prod"));
		const secondPw = mem.store.get("io.nextain.naia\0auth-master-v1");
		expect(secondPw).toBeTruthy();
		expect(secondPw).not.toBe(firstPw);
	});
});

