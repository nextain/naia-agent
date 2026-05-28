// Unit tests for #337 Phase 5a IPC handlers.
//
// Approach (documented in commit message): handlers are extracted into a pure
// async module rather than buried in the bin/naia-agent.ts switch — that keeps
// the dispatcher diff small and makes the handlers unit-testable without
// spawning a child process.
//
// Strategy:
//   * Real auth-store + real oauth-flow + in-memory keyring fixture (same
//     pattern as auth-store.test.ts / oauth-flow.test.ts).
//   * tmpdir as NAIA_ADK_PATH so file paths don't collide.
//   * `fetch` is stubbed for lab_proxy_request tests — we never make real HTTP
//     calls. Stubbing is per-test via the fetchImpl parameter.

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
	loadAuth,
} from "../../utils/auth-store.js";
import { __resetOAuthFlowForTest } from "../../utils/oauth-flow.js";
import { __resetRefreshForTest } from "../refresh.js";

import {
	handleAuthLegacyMigrate,
	handleAuthLogout,
	handleAuthQuery,
	handleAuthReceived,
	handleAuthStart,
	handleLabProxyRequest,
} from "../ipc-handlers.js";

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
	adkRoot = await mkdtemp(path.join(tmpdir(), "naia-auth-ipc-"));
	process.env.NAIA_ADK_PATH = adkRoot;
	delete process.env.NAIA_AGENT_MODE;
	__setKeyringForTest(makeMemKeyring());
	__resetAuthStoreForTest();
	__resetOAuthFlowForTest();
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

// --- auth_start --------------------------------------------------------------

describe("handleAuthStart", () => {
	it("returns authUrl containing localhost:3001 for dev mode + 64-char state", () => {
		const result = handleAuthStart({ mode: "dev" });
		expect(result.authUrl).toContain("localhost:3001");
		expect(result.state).toMatch(/^[0-9a-f]{64}$/);
	});

	it("returns naia.nextain.io authUrl for prod mode", () => {
		const result = handleAuthStart({ mode: "prod" });
		expect(result.authUrl).toContain("naia.nextain.io");
	});

	it("threads through scope + locale", () => {
		const result = handleAuthStart({
			mode: "dev",
			scope: ["chat", "memory"],
			locale: "ko",
		});
		expect(result.authUrl).toContain("/ko/login");
		expect(result.authUrl).toContain("scope=chat%2Cmemory");
	});
});

// --- auth_query (cold) -------------------------------------------------------

describe("handleAuthQuery (empty store)", () => {
	it("returns loggedIn: false when no auth file exists", async () => {
		const result = await handleAuthQuery({ mode: "dev" });
		expect(result).toEqual({ loggedIn: false });
	});

	it("returns loggedIn: false for both modes independently", async () => {
		expect(await handleAuthQuery({ mode: "dev" })).toEqual({ loggedIn: false });
		expect(await handleAuthQuery({ mode: "prod" })).toEqual({ loggedIn: false });
	});
});

// --- end-to-end: start → received → query → logout --------------------------

function makeDeepLink(state: string, key = "gw-test-key-12345", userId = "naia_test"): string {
	const params = new URLSearchParams();
	params.set("key", key);
	params.set("user_id", userId);
	params.set("state", state);
	return `naia://auth?${params.toString()}`;
}

describe("E2E: auth_start → auth_received → auth_query → auth_logout", () => {
	it("full login flow persists state and auth_query returns userId without naiaKey", async () => {
		const startResult = handleAuthStart({ mode: "dev" });

		const receivedResult = await handleAuthReceived({
			deepLinkUrl: makeDeepLink(startResult.state),
		});
		expect(receivedResult.ok).toBe(true);
		expect(receivedResult.userId).toBe("naia_test");
		// CRITICAL: response must never include the naiaKey.
		expect(JSON.stringify(receivedResult)).not.toContain("gw-test-key-12345");

		const queryResult = await handleAuthQuery({ mode: "dev" });
		expect(queryResult.loggedIn).toBe(true);
		expect(queryResult.userId).toBe("naia_test");
		// CRITICAL: response must never include the naiaKey.
		expect(JSON.stringify(queryResult)).not.toContain("gw-test-key-12345");
		// And no refreshToken / issuer either (those are also secret-adjacent).
		expect(JSON.stringify(queryResult)).not.toMatch(/refreshToken|issuer/);
	});

	it("auth_logout clears the file and subsequent auth_query returns false", async () => {
		const startResult = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(startResult.state) });
		expect((await handleAuthQuery({ mode: "dev" })).loggedIn).toBe(true);

		const logoutResult = await handleAuthLogout({ mode: "dev" });
		expect(logoutResult).toEqual({ ok: true });

		expect(await handleAuthQuery({ mode: "dev" })).toEqual({ loggedIn: false });
	});

	it("auth_logout is idempotent when no file exists", async () => {
		const result = await handleAuthLogout({ mode: "prod" });
		expect(result).toEqual({ ok: true });
	});
});

// --- auth_received error cases ----------------------------------------------

describe("handleAuthReceived — rejection paths", () => {
	it("rejects deep-link with unknown state", async () => {
		const result = await handleAuthReceived({
			deepLinkUrl: makeDeepLink("0".repeat(64)),
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("unknown_state");
	});

	it("rejects malformed deep-link URLs", async () => {
		const result = await handleAuthReceived({ deepLinkUrl: "not-a-url-at-all" });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("malformed_url");
	});

	it("rejects deep-link missing the key param even with valid state", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		const result = await handleAuthReceived({
			deepLinkUrl: `naia://auth?state=${state}`,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("missing_key");
	});
});

// --- lab_proxy_request -------------------------------------------------------

describe("handleLabProxyRequest", () => {
	it("returns 401 not_logged_in when no auth file exists", async () => {
		const result = await handleLabProxyRequest({
			mode: "dev",
			method: "GET",
			path: "/api/balance",
		});
		expect(result).toEqual({
			ok: false,
			status: 401,
			body: null,
			error: "not_logged_in",
		});
	});

	it("injects X-AnyLLM-Key Bearer header from stored naiaKey when logged in", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({
			deepLinkUrl: makeDeepLink(state, "gw-secret-abc"),
		});

		// Capture the outbound request via a stub fetch.
		const captured: { url: string; init?: RequestInit } = { url: "" };
		const stubFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			captured.url = String(url);
			if (init !== undefined) captured.init = init;
			return new Response(JSON.stringify({ balance: 42 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
		);

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ balance: 42 });
		// Header injection — Bearer prefix matches lab-proxy.ts:124-129 convention.
		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["X-AnyLLM-Key"]).toBe("Bearer gw-secret-abc");
		// CRITICAL: response NEVER echoes the naiaKey back in any form.
		expect(JSON.stringify(result)).not.toContain("gw-secret-abc");
	});

	it("prepends issuer to relative path", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state) });

		const urls: string[] = [];
		const stubFetch = vi.fn(async (url: RequestInfo | URL) => {
			urls.push(String(url));
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
		);

		expect(urls[0]).toBe("http://localhost:3001/api/balance");
	});

	// --- #337 cross-review HIGH #3: restrict proxy to issuer-origin ----------

	it("accepts absolute URL matching issuer origin exactly", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state) });

		const urls: string[] = [];
		const stubFetch = vi.fn(async (url: RequestInfo | URL) => {
			urls.push(String(url));
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await handleLabProxyRequest(
			{
				mode: "dev",
				method: "GET",
				path: "http://localhost:3001/api/balance",
			},
			stubFetch,
		);

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(stubFetch).toHaveBeenCalledTimes(1);
		expect(urls[0]).toBe("http://localhost:3001/api/balance");
	});

	it("rejects absolute URL to a different host with disallowed_host (fetch NOT called)", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({
			deepLinkUrl: makeDeepLink(state, "gw-secret-leak"),
		});

		const stubFetch = vi.fn(async () => {
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const result = await handleLabProxyRequest(
			{
				mode: "dev",
				method: "GET",
				path: "https://evil.com/leak",
			},
			stubFetch,
		);

		expect(result).toEqual({
			ok: false,
			status: 400,
			body: null,
			error: "disallowed_host",
		});
		expect(stubFetch).not.toHaveBeenCalled();
		// CRITICAL: naiaKey must not leak through the rejected response.
		expect(JSON.stringify(result)).not.toContain("gw-secret-leak");
	});

	it("rejects malformed URL with invalid_path (fetch NOT called)", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({
			deepLinkUrl: makeDeepLink(state, "gw-secret-mal"),
		});

		const stubFetch = vi.fn(async () => {
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "://bogus" },
			stubFetch,
		);

		expect(result).toEqual({
			ok: false,
			status: 400,
			body: null,
			error: "invalid_path",
		});
		expect(stubFetch).not.toHaveBeenCalled();
		// CRITICAL: naiaKey must not leak through the rejected response.
		expect(JSON.stringify(result)).not.toContain("gw-secret-mal");
	});

	it("returns ok:false status:0 on fetch network error", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state) });

		const stubFetch = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
		);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.error).toContain("ECONNREFUSED");
	});

	it("serializes JSON body for POST requests", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state) });

		let sentBody: BodyInit | null | undefined;
		const stubFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			sentBody = init?.body;
			return new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await handleLabProxyRequest(
			{ mode: "dev", method: "POST", path: "/api/link", body: { channel: "x" } },
			stubFetch,
		);
		expect(sentBody).toBe(JSON.stringify({ channel: "x" }));
	});

	it("returns ok:false when upstream status >= 400, body preserved", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state) });

		const stubFetch = vi.fn(async () => {
			return new Response(JSON.stringify({ error: "rate_limited" }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
		);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(429);
		expect(result.body).toEqual({ error: "rate_limited" });
	});
});

// --- regression: persisted state never appears in any handler response ------

describe("naiaKey leak guard", () => {
	it("auth_received / auth_query / lab_proxy_request all strip naiaKey", async () => {
		const SECRET = "gw-supersecret-9f8e7d6c5b";
		const { state } = handleAuthStart({ mode: "dev" });
		const received = await handleAuthReceived({
			deepLinkUrl: makeDeepLink(state, SECRET),
		});
		const query = await handleAuthQuery({ mode: "dev" });

		// The file on disk DOES contain the key (encrypted) — verify via loadAuth
		// to make sure our test fixture actually persisted what we think.
		const onDisk = await loadAuth("dev");
		expect(onDisk?.naiaKey).toBe(SECRET);

		// But none of the IPC responses may surface it.
		for (const resp of [received, query]) {
			expect(JSON.stringify(resp)).not.toContain(SECRET);
		}

		const stubFetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
		const proxyResult = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
		);
		expect(JSON.stringify(proxyResult)).not.toContain(SECRET);
	});
});

// --- #337 Phase 7: refresh-on-401 retry loop --------------------------------

describe("handleLabProxyRequest — 401 refresh retry (#337 Phase 7)", () => {
	it("200 response → refresh fetch never invoked", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({
			deepLinkUrl: makeDeepLink(state, "gw-init"),
		});
		// Manually attach a refreshToken so the path is plausible. We bypass the
		// portal — Phase 4 oauth-flow doesn't set refreshToken — by re-saving via
		// loadAuth + saveAuth.
		const cur = await loadAuth("dev");
		if (!cur) throw new Error("expected logged-in state");
		await (await import("../../utils/auth-store.js")).saveAuth({
			...cur,
			refreshToken: "rt-abc",
		});

		const stubFetch = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		) as unknown as typeof fetch;
		const emit = vi.fn();

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
			emit,
		);

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(stubFetch).toHaveBeenCalledTimes(1);
		// no /api/auth/refresh call
		const urls = (stubFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
			(c: unknown[]) => String(c[0]),
		);
		expect(urls.some((u: string) => u.includes("/api/auth/refresh"))).toBe(false);
		expect(emit).not.toHaveBeenCalled();
	});

	it("401 + refresh succeeds → retry returns 200 to caller", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state, "gw-old") });
		const cur = await loadAuth("dev");
		if (!cur) throw new Error("expected logged-in state");
		await (await import("../../utils/auth-store.js")).saveAuth({
			...cur,
			refreshToken: "rt-abc",
		});

		const calls: Array<{ url: string; auth: string }> = [];
		let labCallNo = 0;
		const stubFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			const hdrs = init?.headers as Record<string, string> | undefined;
			calls.push({ url: u, auth: hdrs?.["X-AnyLLM-Key"] ?? "" });

			if (u.endsWith("/api/auth/refresh")) {
				return new Response(
					JSON.stringify({
						naiaKey: "gw-rotated",
						refreshToken: "rt-rotated",
						expiresAt: 1700007200,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			labCallNo++;
			if (labCallNo === 1) {
				// first lab call → 401
				return new Response("Unauthorized", { status: 401 });
			}
			// retry after refresh → 200
			return new Response(JSON.stringify({ balance: 99 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const emit = vi.fn();

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
			emit,
		);

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ balance: 99 });
		// 3 fetches: lab(401), refresh(200), lab-retry(200)
		expect(stubFetch).toHaveBeenCalledTimes(3);
		// First lab call used original key, retry used rotated key
		const labCalls = calls.filter((c) => c.url.endsWith("/api/balance"));
		expect(labCalls.length).toBe(2);
		expect(labCalls[0]?.auth).toBe("Bearer gw-old");
		expect(labCalls[1]?.auth).toBe("Bearer gw-rotated");
		// Refresh succeeded — no auth_expired emitted
		expect(emit).not.toHaveBeenCalled();
	});

	it("401 + refresh fails (404) → caller sees original 401 + emit once", async () => {
		const { state } = handleAuthStart({ mode: "dev" });
		await handleAuthReceived({ deepLinkUrl: makeDeepLink(state, "gw-old") });
		const cur = await loadAuth("dev");
		if (!cur) throw new Error("expected logged-in state");
		await (await import("../../utils/auth-store.js")).saveAuth({
			...cur,
			refreshToken: "rt-abc",
		});

		const stubFetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.endsWith("/api/auth/refresh")) {
				return new Response("Not Found", { status: 404 });
			}
			return new Response("Unauthorized", { status: 401 });
		}) as unknown as typeof fetch;
		const emit = vi.fn();

		const result = await handleLabProxyRequest(
			{ mode: "dev", method: "GET", path: "/api/balance" },
			stubFetch,
			emit,
		);

		expect(result.ok).toBe(false);
		expect(result.status).toBe(401);
		// 2 fetches: lab(401) + refresh(404). NO retry.
		expect(stubFetch).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({
			type: "auth_expired",
			mode: "dev",
			reason: "refresh_failed",
		});
	});
});

// --- #337 Phase 8: legacy migration -----------------------------------------

describe("handleAuthLegacyMigrate (#337 Phase 8)", () => {
	it("happy path: persists AuthState via saveAuth and returns ok:true", async () => {
		const before = Math.floor(Date.now() / 1000);
		const result = await handleAuthLegacyMigrate({
			mode: "prod",
			naiaKey: "gw-legacy-abc",
			userId: "naia_legacy_user",
		});
		const after = Math.floor(Date.now() / 1000);

		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();

		const onDisk = await loadAuth("prod");
		expect(onDisk).not.toBeNull();
		expect(onDisk?.naiaKey).toBe("gw-legacy-abc");
		expect(onDisk?.userId).toBe("naia_legacy_user");
		expect(onDisk?.mode).toBe("prod");
		expect(onDisk?.schema).toBe(1);
		expect(onDisk?.keyVersion).toBe(1);
		// refreshToken, expiresAt, rotatedAt must all be null (no portal session).
		expect(onDisk?.refreshToken).toBeNull();
		expect(onDisk?.expiresAt).toBeNull();
		expect(onDisk?.rotatedAt).toBeNull();
		// scope empty array, issuedAt = now (in unix seconds).
		expect(onDisk?.scope).toEqual([]);
		expect(onDisk?.issuedAt).toBeGreaterThanOrEqual(before);
		expect(onDisk?.issuedAt).toBeLessThanOrEqual(after);
		// Mode-derived default issuer (prod = naia.nextain.io).
		expect(onDisk?.issuer).toBe("https://naia.nextain.io");
	});

	it("dev mode uses localhost:3001 issuer", async () => {
		const result = await handleAuthLegacyMigrate({
			mode: "dev",
			naiaKey: "gw-legacy-dev",
		});
		expect(result.ok).toBe(true);
		const onDisk = await loadAuth("dev");
		expect(onDisk?.issuer).toBe("http://localhost:3001");
	});

	it("missing userId defaults to empty string", async () => {
		const result = await handleAuthLegacyMigrate({
			mode: "prod",
			naiaKey: "gw-no-user",
		});
		expect(result.ok).toBe(true);
		const onDisk = await loadAuth("prod");
		expect(onDisk?.userId).toBe("");
	});

	it("empty naiaKey returns ok:false reason:missing_naia_key, no saveAuth", async () => {
		const result = await handleAuthLegacyMigrate({
			mode: "prod",
			naiaKey: "",
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("missing_naia_key");
		const onDisk = await loadAuth("prod");
		expect(onDisk).toBeNull();
	});

	it("saveAuth throw → returns ok:false with error message", async () => {
		// Force saveAuth to throw by unsetting NAIA_ADK_PATH — getAuthFilePath
		// explicitly rejects with this message when the env var is missing.
		delete process.env.NAIA_ADK_PATH;
		try {
			const result = await handleAuthLegacyMigrate({
				mode: "prod",
				naiaKey: "gw-ok",
			});
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("NAIA_ADK_PATH");
		} finally {
			process.env.NAIA_ADK_PATH = adkRoot;
		}
	});

	it("result never echoes the naiaKey (defense-in-depth)", async () => {
		const SECRET = "gw-supersecret-99887766";
		const result = await handleAuthLegacyMigrate({
			mode: "prod",
			naiaKey: SECRET,
			userId: "naia_x",
		});
		expect(result.ok).toBe(true);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});
