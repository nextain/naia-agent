// Refresh-token rotation + single-flight mutex for #337 Phase 7.
//
// Provides a per-mode single-flight wrapper around the refresh-token exchange
// against the Naia portal. Concurrent callers join the same in-flight promise
// rather than triggering duplicate refreshes or failing fast — per design doc
// §2.6 / cross-review §9.6.
//
// On success: rotates AuthState (new naiaKey / refreshToken / expiresAt,
// rotatedAt = issuedAt = now) and persists via saveAuth.
// On failure: emits an `auth_expired` sentinel event via the caller-supplied
// `emit` callback so the shell can surface a re-login prompt.
//
// Out of scope:
//   * Wiring the 401 retry loop — `handleLabProxyRequest` consumes this module.
//   * Portal endpoint implementation — Naia portal does NOT currently expose
//     `/api/auth/refresh`; the 404 branch is the expected path until the
//     portal ships its side. Agent tolerates this gracefully (cross-repo work).

import {
	type AuthMode,
	type AuthState,
	loadAuth,
	saveAuth,
} from "../utils/auth-store.js";

// --- public types ------------------------------------------------------------

export type RefreshFailureReason = "refresh_failed" | "revoked" | "no_token";

export interface RefreshResult {
	ok: boolean;
	state?: AuthState;
	reason?: RefreshFailureReason;
}

export interface RefreshAuthOptions {
	emit?: (event: {
		type: "auth_expired";
		mode: AuthMode;
		reason: RefreshFailureReason;
	}) => void;
	fetchImpl?: typeof fetch;
}

// --- single-flight mutex -----------------------------------------------------

const inflight = new Map<AuthMode, Promise<RefreshResult>>();

export function refreshAuth(
	mode: AuthMode,
	opts?: RefreshAuthOptions,
): Promise<RefreshResult> {
	const existing = inflight.get(mode);
	if (existing) return existing;
	const p = doRefresh(mode, opts).finally(() => inflight.delete(mode));
	inflight.set(mode, p);
	return p;
}

// --- core refresh flow -------------------------------------------------------

async function doRefresh(
	mode: AuthMode,
	opts: RefreshAuthOptions | undefined,
): Promise<RefreshResult> {
	const fetchImpl = opts?.fetchImpl ?? fetch;
	const emit = opts?.emit;

	const state = await loadAuth(mode);
	if (!state) {
		// no_token = "never logged in" — caller (lab-proxy) returns 401 directly;
		// do NOT emit auth_expired (that would be a false alarm for a UI that
		// is already in the logged-out state).
		return { ok: false, reason: "no_token" };
	}
	if (state.refreshToken === null) {
		return { ok: false, reason: "no_token" };
	}

	let res: Response;
	try {
		res = await fetchImpl(`${state.issuer}/api/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refreshToken: state.refreshToken }),
		});
	} catch {
		return emitAndReturn(emit, mode, "refresh_failed");
	}

	if (res.status === 401 || res.status === 403) {
		return emitAndReturn(emit, mode, "revoked");
	}
	if (res.status < 200 || res.status >= 300) {
		// 404 (endpoint not implemented) folds into refresh_failed — the agent
		// gives up the optimistic refresh and surfaces auth_expired so the UI
		// can prompt re-login.
		return emitAndReturn(emit, mode, "refresh_failed");
	}

	let body: { naiaKey?: string; refreshToken?: string; expiresAt?: number | null };
	try {
		body = (await res.json()) as typeof body;
	} catch {
		return emitAndReturn(emit, mode, "refresh_failed");
	}

	if (typeof body.naiaKey !== "string" || body.naiaKey.length === 0) {
		return emitAndReturn(emit, mode, "refresh_failed");
	}

	const now = Math.floor(Date.now() / 1000);
	const newState: AuthState = {
		...state,
		naiaKey: body.naiaKey,
		refreshToken:
			typeof body.refreshToken === "string" ? body.refreshToken : state.refreshToken,
		expiresAt:
			typeof body.expiresAt === "number" || body.expiresAt === null
				? body.expiresAt
				: state.expiresAt,
		issuedAt: now,
		rotatedAt: now,
	};

	await saveAuth(newState);
	return { ok: true, state: newState };
}

function emitAndReturn(
	emit: RefreshAuthOptions["emit"],
	mode: AuthMode,
	reason: Exclude<RefreshFailureReason, "no_token">,
): RefreshResult {
	if (emit) emit({ type: "auth_expired", mode, reason });
	return { ok: false, reason };
}

// --- test seam ---------------------------------------------------------------

/** Reset in-process state (single-flight map) for isolated tests. */
export function __resetRefreshForTest(): void {
	inflight.clear();
}
