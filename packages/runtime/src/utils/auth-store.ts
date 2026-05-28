// Encrypted auth-file store for #337 Phase 3.
//
// Persists per-mode bearer tokens at
//   <NAIA_ADK_PATH>/naia-settings/auth/{mode}.json.enc
// using the Phase 2a crypto envelope and the Phase 2b OS-keyring abstraction.
//
// Responsibilities (per design doc §2.2 / §2.6 / §2.9):
//   * Encrypt/decrypt the auth blob with a single per-machine master password
//     stored once in the OS keyring (service "io.nextain.naia",
//     account "auth-master-v1"). First use bootstraps the password.
//   * Atomic writes (`.tmp` + rename) so a mid-write crash never produces a
//     half-written file.
//   * Concurrent readers OK, writers serialized — implemented with a tiny
//     in-process readers-writer lock keyed by mode. dev/prod are independent.
//   * `mode` resolved from the NAIA_AGENT_MODE env var (default "prod").
//   * Tamper / schema / mode mismatches surface as explicit errors so the
//     caller can react (logout + warn user) rather than silently treating a
//     bad file as "logged out".
//
// Out of scope (deferred to later phases):
//   * Refresh-token rotation + single-flight (Phase 7).
//   * OAuth state generation + deep-link parsing (Phase 4).
//   * Master-key rotation — `keyVersion` is stored day-1 (cross-review §9.4)
//     but only the single value 1 is honored.

import { mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import {
	encryptEnvelope,
	decryptEnvelope,
	generateMasterPassword,
} from "./crypto-envelope.js";
import { getMasterPassword, setMasterPassword } from "./keyring.js";

// --- public types ------------------------------------------------------------

export type AuthMode = "dev" | "prod";

export interface AuthState {
	schema: 1;
	keyVersion: 1;
	mode: AuthMode;
	naiaKey: string;
	refreshToken: string | null;
	userId: string;
	issuer: string;
	scope: string[];
	issuedAt: number;
	expiresAt: number | null;
	rotatedAt: number | null;
}

// --- constants ---------------------------------------------------------------

const KEYRING_SERVICE = "io.nextain.naia";
const KEYRING_ACCOUNT = "auth-master-v1";

// --- mode + path resolution --------------------------------------------------

export function getCurrentMode(): AuthMode {
	const v = process.env.NAIA_AGENT_MODE;
	return v === "dev" ? "dev" : "prod";
}

export function getAuthFilePath(mode: AuthMode): string {
	const adkPath = process.env.NAIA_ADK_PATH;
	if (!adkPath) {
		throw new Error("NAIA_ADK_PATH not set — cannot resolve auth file path");
	}
	return path.join(adkPath, "naia-settings", "auth", `${mode}.json.enc`);
}

// --- RW lock (per mode) ------------------------------------------------------

class RWLock {
	private readers = 0;
	private writerActive = false;
	private waiters: Array<{ kind: "read" | "write"; resolve: () => void }> = [];

	async withRead<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquireRead();
		try {
			return await fn();
		} finally {
			this.releaseRead();
		}
	}

	async withWrite<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquireWrite();
		try {
			return await fn();
		} finally {
			this.releaseWrite();
		}
	}

	private acquireRead(): Promise<void> {
		// Readers wait if a writer is active OR a writer is queued ahead
		// (fairness — prevents writer starvation).
		const writerQueued = this.waiters.some((w) => w.kind === "write");
		if (!this.writerActive && !writerQueued) {
			this.readers++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push({ kind: "read", resolve });
		});
	}

	private releaseRead(): void {
		this.readers--;
		this.drain();
	}

	private acquireWrite(): Promise<void> {
		if (!this.writerActive && this.readers === 0) {
			this.writerActive = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push({ kind: "write", resolve });
		});
	}

	private releaseWrite(): void {
		this.writerActive = false;
		this.drain();
	}

	private drain(): void {
		if (this.writerActive || this.readers > 0) return;
		const head = this.waiters[0];
		if (!head) return;
		if (head.kind === "write") {
			this.waiters.shift();
			this.writerActive = true;
			head.resolve();
			return;
		}
		// Wake all consecutive readers at the head of the queue.
		while (this.waiters[0]?.kind === "read") {
			const r = this.waiters.shift()!;
			this.readers++;
			r.resolve();
		}
	}
}

const locks = new Map<AuthMode, RWLock>();
function lockFor(mode: AuthMode): RWLock {
	let l = locks.get(mode);
	if (!l) {
		l = new RWLock();
		locks.set(mode, l);
	}
	return l;
}

// --- master password cache ---------------------------------------------------

let cachedMasterPassword: string | null = null;

async function ensureMasterPassword(): Promise<string> {
	if (cachedMasterPassword !== null) return cachedMasterPassword;
	const existing = await getMasterPassword(KEYRING_SERVICE, KEYRING_ACCOUNT);
	if (existing !== null) {
		cachedMasterPassword = existing;
		return existing;
	}
	const fresh = generateMasterPassword();
	await setMasterPassword(KEYRING_SERVICE, KEYRING_ACCOUNT, fresh);
	cachedMasterPassword = fresh;
	return fresh;
}

// --- atomic write ------------------------------------------------------------

async function atomicWrite(filePath: string, data: Uint8Array): Promise<void> {
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, data);
	await rename(tmp, filePath);
}

// --- public API --------------------------------------------------------------

export async function loadAuth(mode: AuthMode): Promise<AuthState | null> {
	return lockFor(mode).withRead(async () => {
		const filePath = getAuthFilePath(mode);

		// File missing → null (cold boot).
		let blob: Uint8Array;
		try {
			blob = await readFile(filePath);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}

		// Keyring has no master password → cannot decrypt. Return null rather
		// than throwing — this matches the "no creds available" semantics the
		// caller expects on fresh installs where the keyring was wiped but a
		// stale file remained.
		const existing = await getMasterPassword(KEYRING_SERVICE, KEYRING_ACCOUNT);
		if (existing === null) return null;
		cachedMasterPassword = existing;

		const plaintext = await decryptEnvelope(blob, existing);
		const json = new TextDecoder().decode(plaintext);
		const parsed = JSON.parse(json) as AuthState;

		if (parsed.schema !== 1) {
			throw new Error(`Auth file schema mismatch: expected 1, got ${parsed.schema}`);
		}
		if (parsed.keyVersion !== 1) {
			throw new Error(
				`Auth file keyVersion mismatch: expected 1, got ${parsed.keyVersion}`,
			);
		}
		if (parsed.mode !== mode) {
			throw new Error(
				`Auth file mode mismatch: expected ${mode}, got ${parsed.mode}`,
			);
		}
		return parsed;
	});
}

export async function saveAuth(state: AuthState): Promise<void> {
	const mode = state.mode;
	return lockFor(mode).withWrite(async () => {
		const password = await ensureMasterPassword();
		const filePath = getAuthFilePath(mode);
		await mkdir(path.dirname(filePath), { recursive: true });

		const plaintext = new TextEncoder().encode(JSON.stringify(state));
		const blob = await encryptEnvelope(plaintext, password);
		await atomicWrite(filePath, blob);
	});
}

export async function deleteAuth(mode: AuthMode): Promise<void> {
	return lockFor(mode).withWrite(async () => {
		const filePath = getAuthFilePath(mode);
		await rm(filePath, { force: true });
	});
}

// --- test seam ---------------------------------------------------------------

/** Reset in-process state (RW locks + cached master password) for isolated
 *  tests. Does NOT touch the keyring or any files on disk. */
export function __resetAuthStoreForTest(): void {
	locks.clear();
	cachedMasterPassword = null;
}
