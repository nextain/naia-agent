// OAuth flow handler for #337 Phase 4.
//
// Pure-function module + in-memory state manager. Phase 5 wires this to shell
// IPC. Responsibilities (per design doc §2.5 / §2.7):
//
//   * Generate OAuth state tokens (32-byte hex) with mode/issuer/scope binding
//     and a 5-minute TTL, in-memory only — no disk persistence (a crashed
//     agent forces re-login, identical to current shell behavior, §8 Q3).
//   * Build the Naia portal login URL with state embedded.
//   * Parse incoming `naia://auth?...` deep-link URLs, validate state, and
//     persist the resulting bearer token via auth-store.saveAuth().
//   * Maintain a forensic in-memory log of every deep-link receive event —
//     success and reject both logged — for security forensics (§2.7).
//
// Out of scope by design:
//   * PKCE — deferred to a portal-side follow-up issue (§2.7 / §9.5). The
//     current portal returns naiaKey directly in `naia://auth?key=...`; we
//     honor that flow with stronger state validation + TTL.
//   * Shell IPC wiring — Phase 5 picks that up; this module only exposes the
//     pure functions Phase 5 will call.

import { randomBytes } from "node:crypto";

import { type AuthMode, type AuthState, saveAuth } from "./auth-store.js";

// --- public types ------------------------------------------------------------

export interface OAuthStartOptions {
	mode: AuthMode;
	/** Override portal base URL — defaults to mode-derived issuer. */
	issuerOverride?: string;
	/** Requested scopes — opaque strings, passed to portal as comma-separated
	 *  `scope=` query. Empty array → no `scope=` param emitted. */
	scope?: string[];
	/** Locale segment for portal URL (e.g. "ko", "en"). Default "en". */
	locale?: string;
}

export interface OAuthStartResult {
	/** Full URL to open in webview. */
	authUrl: string;
	/** State token (caller should not store — it's already in-memory in this
	 *  module). Exposed mainly for tests + log correlation. */
	state: string;
}

export type OAuthRejectReason =
	| "missing_state"
	| "unknown_state"
	| "expired_state"
	| "mode_mismatch"
	| "missing_key"
	| "malformed_url";

export interface OAuthReceiveResult {
	ok: boolean;
	reason?: OAuthRejectReason;
	authState?: AuthState; // populated on ok:true
}

export interface OAuthLogEntry {
	timestamp: number; // unix ms
	event: "start" | "receive_success" | "receive_reject";
	reason?: OAuthRejectReason;
	mode?: AuthMode;
	state?: string; // OK to log — short-lived, already used
	userId?: string; // OK on success
	// NEVER log naiaKey or any secret.
}

// --- constants ---------------------------------------------------------------

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LOG_BUFFER_CAP = 1000;

// --- issuer URL resolution ---------------------------------------------------

function resolveIssuer(mode: AuthMode, override?: string): string {
	if (override) return override;
	return mode === "dev" ? "http://localhost:3001" : "https://naia.nextain.io";
}

// --- in-memory state map -----------------------------------------------------

interface BoundState {
	mode: AuthMode;
	issuer: string;
	scope: string[];
	expiresAt: number; // unix ms
}

const stateMap = new Map<string, BoundState>();

// --- forensic log ------------------------------------------------------------

const logBuffer: OAuthLogEntry[] = [];
const logListeners = new Set<(entry: OAuthLogEntry) => void>();

function appendLog(entry: OAuthLogEntry): void {
	logBuffer.push(entry);
	if (logBuffer.length > LOG_BUFFER_CAP) {
		logBuffer.shift();
	}
	for (const listener of logListeners) {
		try {
			listener(entry);
		} catch {
			// Subscribers must not crash the flow. Swallow silently — the buffer
			// itself is the durable record.
		}
	}
}

// --- public API --------------------------------------------------------------

/** Begin an OAuth flow. Generates a state token, stores it with 5-min TTL,
 *  returns the URL the shell should open in a webview. */
export function startOAuth(opts: OAuthStartOptions): OAuthStartResult {
	const mode = opts.mode;
	const issuer = resolveIssuer(mode, opts.issuerOverride);
	const scope = opts.scope ?? [];
	const locale = opts.locale ?? "en";

	const state = randomBytes(32).toString("hex");
	stateMap.set(state, {
		mode,
		issuer,
		scope,
		expiresAt: Date.now() + STATE_TTL_MS,
	});

	const params = new URLSearchParams();
	if (scope.length > 0) params.set("scope", scope.join(","));
	params.set("state", state);
	params.set("app", "naia-os");
	params.set("platform", process.platform);
	// #337 callback fix (2026-05-28): portal's middleware honors `redirect=desktop`
	// to send already-logged-in sessions to /callback (which fires the naia://
	// deep-link) instead of /dashboard. Without these params the portal silently
	// redirects to dashboard and the Tauri shell waits forever.
	// portal: naia.nextain.io src/proxy.ts:86-91
	params.set("redirect", "desktop");
	params.set("source", "desktop");
	const authUrl = `${issuer}/${locale}/login?${params.toString()}`;

	appendLog({
		timestamp: Date.now(),
		event: "start",
		mode,
		state,
	});

	return { authUrl, state };
}

/** Parse a naia://auth?... deep-link URL. Validates state, persists AuthState
 *  via saveAuth(), returns result. Forensic log emitted regardless of outcome
 *  (success + failure both logged). */
export async function receiveOAuthDeepLink(
	deepLinkUrl: string,
): Promise<OAuthReceiveResult> {
	// naia:// is not in WHATWG's special-scheme list, so query parsing via the
	// standard URL constructor on the raw scheme is unreliable across
	// implementations. Substitute the scheme with https:// for parsing only —
	// we never use the resulting URL beyond extracting query params.
	let parsed: URL;
	try {
		parsed = new URL(deepLinkUrl.replace(/^naia:\/\//, "https://"));
	} catch {
		return reject("malformed_url");
	}

	const params = parsed.searchParams;
	const stateParam = params.get("state");
	if (!stateParam) return reject("missing_state");

	const bound = stateMap.get(stateParam);
	if (!bound) return reject("unknown_state", undefined, stateParam);

	// Single-use: remove from map immediately. Subsequent receives with the
	// same state will fall into the unknown_state branch above.
	stateMap.delete(stateParam);

	if (Date.now() > bound.expiresAt) {
		return reject("expired_state", bound.mode, stateParam);
	}

	const keyParam = params.get("key");
	if (!keyParam) return reject("missing_key", bound.mode, stateParam);

	const userIdParam = params.get("user_id") ?? "";
	const refreshTokenParam = params.get("refresh_token");
	const expiresAtParam = params.get("expires_at");
	const scopeParam = params.get("scope");

	const now = Math.floor(Date.now() / 1000);
	const authState: AuthState = {
		schema: 1,
		keyVersion: 1,
		mode: bound.mode,
		naiaKey: keyParam,
		refreshToken: refreshTokenParam ?? null,
		userId: userIdParam,
		issuer: bound.issuer,
		scope: scopeParam ? scopeParam.split(",") : bound.scope,
		issuedAt: now,
		expiresAt: expiresAtParam ? Number(expiresAtParam) : null,
		rotatedAt: null,
	};

	await saveAuth(authState);

	appendLog({
		timestamp: Date.now(),
		event: "receive_success",
		mode: bound.mode,
		state: stateParam,
		userId: userIdParam,
	});

	return { ok: true, authState };
}

function reject(
	reason: OAuthRejectReason,
	mode?: AuthMode,
	state?: string,
): OAuthReceiveResult {
	const entry: OAuthLogEntry = {
		timestamp: Date.now(),
		event: "receive_reject",
		reason,
	};
	if (mode !== undefined) entry.mode = mode;
	if (state !== undefined) entry.state = state;
	appendLog(entry);
	return { ok: false, reason };
}

/** Subscribe to forensic log events. Returns an unsubscribe function. */
export function onOAuthLog(
	listener: (entry: OAuthLogEntry) => void,
): () => void {
	logListeners.add(listener);
	return () => {
		logListeners.delete(listener);
	};
}

/** Snapshot copy of the in-memory forensic log buffer. */
export function getOAuthLog(): readonly OAuthLogEntry[] {
	return logBuffer.slice();
}

// --- test seam ---------------------------------------------------------------

/** Reset in-memory state map + log buffer + listeners for isolated tests. */
export function __resetOAuthFlowForTest(): void {
	stateMap.clear();
	logBuffer.length = 0;
	logListeners.clear();
}
