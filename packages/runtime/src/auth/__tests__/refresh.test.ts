// Unit tests for #337 Phase 7 — refresh-token rotation + single-flight mutex.
//
// Pattern mirrors ipc-handlers.test.ts:
//   * Real auth-store + in-memory keyring fixture (same as Phase 3/5a tests).
//   * tmpdir as NAIA_ADK_PATH so file paths don't collide.
//   * `fetch` stubbed per test via `fetchImpl` injection. No real HTTP.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	__setKeyringForTest,
	type KeyringBackend,
} from "../../utils/keyring.js";
import {
	__resetAuthStoreForTest,
	type AuthState,
	loadAuth,
	saveAuth,
} from "../../utils/auth-store.js";

import { __resetRefreshForTest, refreshAuth } from "../refresh.js";

// --- in-memory keyring fixture ----------------------------------------------

function makeMemKeyring(): KeyringBackend {
	const store = new Map<string, string>();
	const k = (s: string, a: string) => `${s}\0${a}`;
	return {
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

beforeEach(async () => {
	adkRoot = await mkdtemp(path.join(tmpdir(), "naia-auth-refresh-"));
	process.env.NAIA_ADK_PATH = adkRoot;
	delete process.env.NAIA_AGENT_MODE;
	__setKeyringForTest(makeMemKeyring());
	__resetAuthStoreForTest();
	__resetRefreshForTest();
});

afterEach(async () => {
	if (ORIG_ADK_PATH !== undefined) process.env.NAIA_ADK_PATH = ORIG_ADK_PATH;
	else delete process.env.NAIA_ADK_PATH;
	if (ORIG_MODE !== undefined) process.env.NAIA_AGENT_MODE = ORIG_MODE;
	else delete process.env.NAIA_AGENT_MODE;
	__setKeyringForTest(undefined);
	await rm(adkRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// --- helpers -----------------------------------------------------------------

function makeAuthState(overrides: Partial<AuthState> = {}): AuthState {
	const base: AuthState = {
		schema: 1,
		keyVersion: 1,
		mode: "dev",
		naiaKey: "gw-original-key",
		refreshToken: "rt-original",
		userId: "naia_test",
		issuer: "http://localhost:3001",
		scope: ["chat"],
		issuedAt: 1700000000,
		expiresAt: 1700003600,
		rotatedAt: null,
	};
	return { ...base, ...overrides };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
	return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
		handler(String(url), init),
	) as unknown as typeof fetch;
}

// --- 1. no token cases (empty store / null refreshToken) --------------------

describe("refreshAuth — no_token cases", () => {
	it("returns no_token when auth store is empty (no file)", async () => {
		const emit = vi.fn();
		const result = await refreshAuth("dev", { emit });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_token");
		expect(emit).not.toHaveBeenCalled();
	});

	it("returns no_token when stored state has refreshToken: null", async () => {
		await saveAuth(makeAuthState({ refreshToken: null }));
		const emit = vi.fn();
		const fetchImpl = stubFetch(() => {
			throw new Error("fetch should not be called");
		});
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_token");
		expect(emit).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

// --- 2. happy path ----------------------------------------------------------

describe("refreshAuth — happy path", () => {
	it("rotates state, sets issuedAt+rotatedAt, persists via saveAuth", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		let capturedUrl = "";
		let capturedBody = "";
		const fetchImpl = stubFetch(async (url, init) => {
			capturedUrl = url;
			capturedBody = String(init?.body ?? "");
			return new Response(
				JSON.stringify({
					naiaKey: "gw-new-key",
					refreshToken: "rt-new",
					expiresAt: 1700007200,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const before = Math.floor(Date.now() / 1000);
		const result = await refreshAuth("dev", { emit, fetchImpl });
		const after = Math.floor(Date.now() / 1000);

		expect(result.ok).toBe(true);
		expect(result.state).toBeDefined();
		expect(result.state?.naiaKey).toBe("gw-new-key");
		expect(result.state?.refreshToken).toBe("rt-new");
		expect(result.state?.expiresAt).toBe(1700007200);
		// rotatedAt + issuedAt set to "now"
		expect(result.state?.rotatedAt).toBeGreaterThanOrEqual(before);
		expect(result.state?.rotatedAt).toBeLessThanOrEqual(after);
		expect(result.state?.issuedAt).toBeGreaterThanOrEqual(before);
		expect(result.state?.issuedAt).toBeLessThanOrEqual(after);
		// userId / issuer / scope preserved from old state
		expect(result.state?.userId).toBe("naia_test");
		expect(result.state?.issuer).toBe("http://localhost:3001");

		// Refresh request shape
		expect(capturedUrl).toBe("http://localhost:3001/api/auth/refresh");
		expect(JSON.parse(capturedBody)).toEqual({ refreshToken: "rt-original" });

		// Persisted to disk
		const onDisk = await loadAuth("dev");
		expect(onDisk?.naiaKey).toBe("gw-new-key");
		expect(onDisk?.refreshToken).toBe("rt-new");

		expect(emit).not.toHaveBeenCalled();
	});
});

// --- 3. portal error responses ----------------------------------------------

describe("refreshAuth — portal error responses", () => {
	it("404 → refresh_failed + emit once", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		const fetchImpl = stubFetch(async () => new Response("Not Found", { status: 404 }));
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("refresh_failed");
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({
			type: "auth_expired",
			mode: "dev",
			reason: "refresh_failed",
		});
	});

	it("401 → revoked + emit once", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		const fetchImpl = stubFetch(async () => new Response("Unauthorized", { status: 401 }));
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("revoked");
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({
			type: "auth_expired",
			mode: "dev",
			reason: "revoked",
		});
	});

	it("403 → revoked + emit once", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		const fetchImpl = stubFetch(async () => new Response("Forbidden", { status: 403 }));
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("revoked");
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("500 → refresh_failed + emit once", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		const fetchImpl = stubFetch(async () => new Response("Server Error", { status: 500 }));
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("refresh_failed");
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("network error (fetch throws) → refresh_failed + emit once", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		const fetchImpl = stubFetch(async () => {
			throw new Error("ECONNREFUSED");
		});
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("refresh_failed");
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({
			type: "auth_expired",
			mode: "dev",
			reason: "refresh_failed",
		});
	});

	it("200 with missing naiaKey → refresh_failed + emit once", async () => {
		await saveAuth(makeAuthState());
		const emit = vi.fn();
		const fetchImpl = stubFetch(
			async () =>
				new Response(JSON.stringify({ refreshToken: "rt-new" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const result = await refreshAuth("dev", { emit, fetchImpl });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("refresh_failed");
		expect(emit).toHaveBeenCalledTimes(1);
	});
});

// --- 4. single-flight mutex --------------------------------------------------

describe("refreshAuth — single-flight mutex", () => {
	it("5 concurrent calls for same mode → fetch called exactly once, same result", async () => {
		await saveAuth(makeAuthState());
		let resolveResponse!: (r: Response) => void;
		const pending = new Promise<Response>((r) => {
			resolveResponse = r;
		});
		// Resolve a "fetch has started" marker once the stub is entered, so the
		// test can synchronize on the in-flight state without polling.
		let fetchEntered!: () => void;
		const fetchEnteredPromise = new Promise<void>((r) => {
			fetchEntered = r;
		});
		const fetchImpl = stubFetch(async () => {
			fetchEntered();
			return pending;
		});

		// Kick off the first call and wait until it reaches the fetch step. This
		// guarantees the inflight slot is populated before any siblings run.
		const first = refreshAuth("dev", { fetchImpl });
		await fetchEnteredPromise;
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const siblings = [
			refreshAuth("dev", { fetchImpl }),
			refreshAuth("dev", { fetchImpl }),
			refreshAuth("dev", { fetchImpl }),
			refreshAuth("dev", { fetchImpl }),
		];
		// Siblings short-circuit to the inflight promise — no new fetch.
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		resolveResponse(
			new Response(
				JSON.stringify({ naiaKey: "gw-new", refreshToken: "rt-new", expiresAt: 1700007200 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const results = await Promise.all([first, ...siblings]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// All five promises resolved to the same object reference (single-flight).
		for (const r of results) {
			expect(r).toBe(results[0]);
			expect(r.ok).toBe(true);
			expect(r.state?.naiaKey).toBe("gw-new");
		}
	});
});

// --- 5. mode isolation -------------------------------------------------------

describe("refreshAuth — mode isolation", () => {
	it("concurrent dev + prod refreshes use independent inflight slots → fetch called twice", async () => {
		await saveAuth(makeAuthState({ mode: "dev", refreshToken: "rt-dev" }));
		await saveAuth(makeAuthState({ mode: "prod", refreshToken: "rt-prod" }));

		const fetchImpl = stubFetch(
			async (_url, init) =>
				new Response(
					JSON.stringify({
						naiaKey: `gw-${JSON.parse(String(init?.body ?? "{}")).refreshToken}-new`,
						refreshToken: "rt-rotated",
						expiresAt: 1700007200,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const [devResult, prodResult] = await Promise.all([
			refreshAuth("dev", { fetchImpl }),
			refreshAuth("prod", { fetchImpl }),
		]);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(devResult.ok).toBe(true);
		expect(prodResult.ok).toBe(true);
		expect(devResult.state?.naiaKey).toBe("gw-rt-dev-new");
		expect(prodResult.state?.naiaKey).toBe("gw-rt-prod-new");
	});
});

// --- 6. inflight cleanup -----------------------------------------------------

describe("refreshAuth — inflight cleanup", () => {
	it("after a refresh completes, the next call triggers a fresh fetch (no stale promise)", async () => {
		await saveAuth(makeAuthState());
		const fetchImpl = stubFetch(
			async () =>
				new Response(
					JSON.stringify({
						naiaKey: "gw-new",
						refreshToken: "rt-new",
						expiresAt: 1700007200,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const r1 = await refreshAuth("dev", { fetchImpl });
		expect(r1.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const r2 = await refreshAuth("dev", { fetchImpl });
		expect(r2.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		// Different result objects (mutex cleared between calls)
		expect(r2).not.toBe(r1);
	});
});
