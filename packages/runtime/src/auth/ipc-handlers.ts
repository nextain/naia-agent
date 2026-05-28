// Auth IPC handlers for #337 Phase 5a.
//
// Pure async functions wired into bin/naia-agent.ts stdio dispatcher. Extracted
// from the dispatcher so each handler is independently unit-testable without
// spawning a child process.
//
// Design contract (per design doc §2.5):
//   * auth_query / auth_logout / auth_received responses NEVER include the
//     naiaKey — the whole point of #337 is that the shell never touches it.
//   * lab_proxy_request injects the naiaKey into outbound HTTP headers and
//     returns only the upstream response body, never the key itself.
//   * auth_received + auth_logout are state transitions — callers also emit
//     `auth_changed` events on stdout (handled in the dispatcher; out of scope
//     for the pure handler).

import {
	type AuthMode,
	type AuthState,
	deleteAuth,
	loadAuth,
	saveAuth,
} from "../utils/auth-store.js";
import {
	receiveOAuthDeepLink,
	startOAuth,
} from "../utils/oauth-flow.js";
import { refreshAuth, type RefreshFailureReason } from "./refresh.js";

// --- public types ------------------------------------------------------------

export interface AuthStartRequest {
	mode: AuthMode;
	scope?: string[];
	locale?: string;
}

export interface AuthStartResponse {
	authUrl: string;
	state: string;
}

export interface AuthReceivedRequest {
	deepLinkUrl: string;
}

export interface AuthReceivedResponse {
	ok: boolean;
	reason?: string;
	userId?: string;
	mode?: AuthMode;
}

export interface AuthLogoutRequest {
	mode: AuthMode;
}

export interface AuthLogoutResponse {
	ok: true;
}

export interface AuthQueryRequest {
	mode: AuthMode;
}

export interface AuthQueryResponse {
	loggedIn: boolean;
	expiresAt?: number;
	userId?: string;
	scope?: string[];
}

export interface AuthLegacyMigrateRequest {
	mode: AuthMode;
	naiaKey: string;
	userId?: string;
}

export interface AuthLegacyMigrateResponse {
	ok: boolean;
	reason?: string;
}

export interface LabProxyRequest {
	mode: AuthMode;
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
}

export interface LabProxyResponse {
	ok: boolean;
	status: number;
	body: unknown;
	error?: string;
}

// --- handlers ----------------------------------------------------------------

export function handleAuthStart(req: AuthStartRequest): AuthStartResponse {
	const opts: Parameters<typeof startOAuth>[0] = { mode: req.mode };
	if (req.scope !== undefined) opts.scope = req.scope;
	if (req.locale !== undefined) opts.locale = req.locale;
	const { authUrl, state } = startOAuth(opts);
	return { authUrl, state };
}

export async function handleAuthReceived(
	req: AuthReceivedRequest,
): Promise<AuthReceivedResponse> {
	const result = await receiveOAuthDeepLink(req.deepLinkUrl);
	if (!result.ok) {
		const resp: AuthReceivedResponse = { ok: false };
		if (result.reason !== undefined) resp.reason = result.reason;
		return resp;
	}
	// On success, saveAuth has already persisted state. Return only non-secret
	// fields so the shell can correlate (userId, mode) — never the naiaKey.
	const resp: AuthReceivedResponse = { ok: true };
	if (result.authState) {
		resp.userId = result.authState.userId;
		resp.mode = result.authState.mode;
	}
	return resp;
}

export async function handleAuthLogout(
	req: AuthLogoutRequest,
): Promise<AuthLogoutResponse> {
	await deleteAuth(req.mode);
	return { ok: true };
}

export async function handleAuthQuery(
	req: AuthQueryRequest,
): Promise<AuthQueryResponse> {
	const state = await loadAuth(req.mode);
	if (!state) return { loggedIn: false };
	// Strip secrets (naiaKey, refreshToken, issuer). Expose only what the shell
	// needs for UI gating. Phase 7 adds refresh logic; here we always report
	// loggedIn: true if the file is present — expiresAt lets the shell warn.
	const resp: AuthQueryResponse = { loggedIn: true };
	if (state.expiresAt !== null) resp.expiresAt = state.expiresAt;
	if (state.userId) resp.userId = state.userId;
	if (state.scope.length > 0) resp.scope = state.scope.slice();
	return resp;
}

/**
 * auth_legacy_migrate handler — one-shot path used by shell Phase 8 to seed
 * the agent's encrypted auth file from the legacy `secure-keys.dat:naiaKey`
 * slot. Matches `auth_received`'s happy-path side effects so the shell never
 * needs to know about the encrypted file directly.
 *
 * Behaviour (design doc §3):
 *  * Build a minimal AuthState (refreshToken=null, expiresAt=null, scope=[]).
 *  * Persist via saveAuth — same as the OAuth deep-link path.
 *  * Return {ok: true} on success; the bin dispatcher is responsible for
 *    emitting the `auth_changed {loggedIn: true}` event.
 *  * On any failure (saveAuth throw / invalid input) return
 *    {ok: false, reason: error.message} — caller must NOT delete the legacy
 *    slot in that case so the user can retry.
 */
export async function handleAuthLegacyMigrate(
	req: AuthLegacyMigrateRequest,
): Promise<AuthLegacyMigrateResponse> {
	try {
		if (!req.naiaKey) {
			return { ok: false, reason: "missing_naia_key" };
		}
		const issuer =
			req.mode === "dev"
				? "http://localhost:3001"
				: "https://naia.nextain.io";
		const now = Math.floor(Date.now() / 1000);
		const state: AuthState = {
			schema: 1,
			keyVersion: 1,
			mode: req.mode,
			naiaKey: req.naiaKey,
			refreshToken: null,
			userId: req.userId ?? "",
			issuer,
			scope: [],
			issuedAt: now,
			expiresAt: null,
			rotatedAt: null,
		};
		await saveAuth(state);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * lab_proxy_request handler — issues an authenticated HTTP request on behalf of
 * the shell. The naiaKey is read from the encrypted auth file and injected
 * into the `X-AnyLLM-Key: Bearer ...` header (matches lab-proxy.ts:124-129).
 *
 * Critical: the response NEVER includes the naiaKey in any form. Upstream
 * response body/status are returned as-is; the key is only used to authorize
 * the outbound fetch.
 *
 * Phase 7: on a 401 from the upstream service, attempt a single refresh-token
 * exchange and retry the request once with the rotated naiaKey. Refresh is
 * single-flight per mode (see `refresh.ts`). On refresh failure, the original
 * 401 is returned to the caller and `emit` is invoked with `auth_expired`.
 *
 * `fetchImpl` is injected for testability — defaults to native fetch.
 * `emit` is injected so the bin dispatcher can route `auth_expired` events to
 * stdout; tests can use a `vi.fn()`.
 */
export async function handleLabProxyRequest(
	req: LabProxyRequest,
	fetchImpl: typeof fetch = fetch,
	emit?: (event: {
		type: "auth_expired";
		mode: AuthMode;
		reason: RefreshFailureReason;
	}) => void,
): Promise<LabProxyResponse> {
	const state = await loadAuth(req.mode);
	if (!state) {
		return { ok: false, status: 401, body: null, error: "not_logged_in" };
	}

	const result = await doFetch(req, state, fetchImpl);
	if (result.status !== 401) return result;

	// 401 — attempt refresh + retry once.
	const refreshOpts: Parameters<typeof refreshAuth>[1] = { fetchImpl };
	if (emit) refreshOpts.emit = emit;
	const refreshed = await refreshAuth(req.mode, refreshOpts);
	if (!refreshed.ok || !refreshed.state) {
		// refreshAuth already emitted auth_expired (when applicable). Surface the
		// original 401 to the caller so it can pivot to a logged-out UI.
		return result;
	}
	return doFetch(req, refreshed.state, fetchImpl);
}

async function doFetch(
	req: LabProxyRequest,
	state: AuthState,
	fetchImpl: typeof fetch,
): Promise<LabProxyResponse> {
	const url = req.path.startsWith("http")
		? req.path
		: `${state.issuer}${req.path.startsWith("/") ? "" : "/"}${req.path}`;

	const headers: Record<string, string> = { ...(req.headers ?? {}) };
	// Override caller's auth header — shell must never see or set this value.
	headers["X-AnyLLM-Key"] = `Bearer ${state.naiaKey}`;
	if (req.body !== undefined && headers["Content-Type"] === undefined) {
		headers["Content-Type"] = "application/json";
	}

	let res: Response;
	try {
		const init: RequestInit = { method: req.method, headers };
		if (req.body !== undefined) {
			init.body = JSON.stringify(req.body);
		}
		res = await fetchImpl(url, init);
	} catch (err) {
		return {
			ok: false,
			status: 0,
			body: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// Parse body — JSON when content-type allows, plain text otherwise.
	const contentType = res.headers.get("content-type") ?? "";
	let body: unknown;
	try {
		if (contentType.includes("application/json")) {
			body = await res.json();
		} else {
			body = await res.text();
		}
	} catch (err) {
		body = null;
		const resp: LabProxyResponse = {
			ok: false,
			status: res.status,
			body: null,
			error: err instanceof Error ? err.message : String(err),
		};
		return resp;
	}

	const resp: LabProxyResponse = {
		ok: res.status < 400,
		status: res.status,
		body,
	};
	return resp;
}
