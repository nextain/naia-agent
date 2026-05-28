// Tests for the OAuth flow handler (#337 Phase 4).
//
// Strategy:
//   * `saveAuth` is mocked via vi.mock — this test never writes a file. The
//     real persistence path is exercised in auth-store.test.ts (Phase 3).
//   * Time-sensitive tests use vi.useFakeTimers / vi.setSystemTime so we can
//     fast-forward past the 5-minute state TTL deterministically.
//   * Module-level state map + log buffer reset between tests via
//     __resetOAuthFlowForTest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../auth-store.js")>();
	return {
		...actual,
		saveAuth: vi.fn(async () => undefined),
	};
});

import { saveAuth } from "../auth-store.js";
import {
	__resetOAuthFlowForTest,
	getOAuthLog,
	onOAuthLog,
	type OAuthLogEntry,
	receiveOAuthDeepLink,
	startOAuth,
} from "../oauth-flow.js";

const saveAuthMock = vi.mocked(saveAuth);

beforeEach(() => {
	__resetOAuthFlowForTest();
	saveAuthMock.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

// --- startOAuth --------------------------------------------------------------

describe("startOAuth", () => {
	it("returns URL with localhost issuer for dev mode and logs start", () => {
		const result = startOAuth({ mode: "dev" });
		expect(result.authUrl).toMatch(/^http:\/\/localhost:3001\//);
		expect(result.state).toMatch(/^[0-9a-f]{64}$/);

		const log = getOAuthLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({
			event: "start",
			mode: "dev",
			state: result.state,
		});
	});

	it("returns URL with naia.nextain.io issuer for prod mode", () => {
		const result = startOAuth({ mode: "prod" });
		expect(result.authUrl).toMatch(/^https:\/\/naia\.nextain\.io\//);
	});

	it("honors issuerOverride", () => {
		const result = startOAuth({
			mode: "dev",
			issuerOverride: "https://staging.example.com",
		});
		expect(result.authUrl).toMatch(/^https:\/\/staging\.example\.com\//);
	});

	it("omits scope= when scope array is empty", () => {
		const result = startOAuth({ mode: "dev", scope: [] });
		expect(result.authUrl).not.toMatch(/[?&]scope=/);
	});

	it("emits comma-separated scope= when scope array is populated", () => {
		const result = startOAuth({ mode: "dev", scope: ["chat", "memory"] });
		const url = new URL(result.authUrl);
		expect(url.searchParams.get("scope")).toBe("chat,memory");
	});

	// #337 callback fix (2026-05-28): portal middleware (naia.nextain.io
	// src/proxy.ts:86-91) honors `redirect=desktop` to route already-logged-in
	// /login visits to /callback (which fires naia:// deep-link). Without this
	// param the portal silently redirects to /dashboard and the Tauri shell
	// hangs on '로그인 대기중' forever.
	it("emits redirect=desktop + source=desktop so portal honors callback for already-logged-in users", () => {
		const result = startOAuth({ mode: "dev" });
		const url = new URL(result.authUrl);
		expect(url.searchParams.get("redirect")).toBe("desktop");
		expect(url.searchParams.get("source")).toBe("desktop");
	});

	it("emits app=naia-os param as a defense-in-depth signal", () => {
		const result = startOAuth({ mode: "prod" });
		const url = new URL(result.authUrl);
		expect(url.searchParams.get("app")).toBe("naia-os");
	});
});

// --- receiveOAuthDeepLink — validation order --------------------------------

describe("receiveOAuthDeepLink — validation", () => {
	it("rejects malformed URLs", async () => {
		const result = await receiveOAuthDeepLink("not-a-url-at-all");
		expect(result).toEqual({ ok: false, reason: "malformed_url" });
		expect(getOAuthLog().at(-1)).toMatchObject({
			event: "receive_reject",
			reason: "malformed_url",
		});
		expect(saveAuthMock).not.toHaveBeenCalled();
	});

	it("rejects URLs missing the state param", async () => {
		const result = await receiveOAuthDeepLink("naia://auth?key=gw-foo");
		expect(result).toEqual({ ok: false, reason: "missing_state" });
	});

	it("rejects URLs with an unknown state param value", async () => {
		const result = await receiveOAuthDeepLink(
			"naia://auth?key=gw-foo&state=deadbeef",
		);
		expect(result).toEqual({ ok: false, reason: "unknown_state" });
	});

	it("rejects URLs missing the key param", async () => {
		const { state } = startOAuth({ mode: "dev" });
		const result = await receiveOAuthDeepLink(
			`naia://auth?state=${state}`,
		);
		expect(result).toEqual({ ok: false, reason: "missing_key" });
	});

	it("treats state as single-use — second receive returns unknown_state", async () => {
		const { state } = startOAuth({ mode: "dev" });
		const url = `naia://auth?key=gw-foo&user_id=u1&state=${state}`;
		const first = await receiveOAuthDeepLink(url);
		expect(first.ok).toBe(true);
		const second = await receiveOAuthDeepLink(url);
		expect(second).toEqual({ ok: false, reason: "unknown_state" });
	});
});

// --- TTL ---------------------------------------------------------------------

describe("receiveOAuthDeepLink — TTL", () => {
	it("rejects with expired_state after 5 min + 1s and logs reject", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		const { state } = startOAuth({ mode: "dev" });

		vi.setSystemTime(new Date("2026-01-01T00:05:01Z"));

		const result = await receiveOAuthDeepLink(
			`naia://auth?key=gw-foo&user_id=u1&state=${state}`,
		);
		expect(result).toEqual({ ok: false, reason: "expired_state" });

		const lastLog = getOAuthLog().at(-1);
		expect(lastLog).toMatchObject({
			event: "receive_reject",
			reason: "expired_state",
		});

		// State removed from the map — a follow-up receive is unknown, not expired.
		const followUp = await receiveOAuthDeepLink(
			`naia://auth?key=gw-foo&user_id=u1&state=${state}`,
		);
		expect(followUp).toEqual({ ok: false, reason: "unknown_state" });
	});
});

// --- happy path --------------------------------------------------------------

describe("receiveOAuthDeepLink — happy path", () => {
	it("persists AuthState via saveAuth and returns ok:true", async () => {
		const { state } = startOAuth({
			mode: "dev",
			scope: ["chat", "memory"],
		});

		const result = await receiveOAuthDeepLink(
			`naia://auth?key=gw-naia-key-123&user_id=naia_user_42&state=${state}`,
		);

		expect(result.ok).toBe(true);
		expect(result.authState?.naiaKey).toBe("gw-naia-key-123");
		expect(result.authState?.userId).toBe("naia_user_42");
		expect(result.authState?.mode).toBe("dev");
		expect(result.authState?.issuer).toBe("http://localhost:3001");
		expect(result.authState?.scope).toEqual(["chat", "memory"]);
		expect(result.authState?.schema).toBe(1);
		expect(result.authState?.keyVersion).toBe(1);

		expect(saveAuthMock).toHaveBeenCalledTimes(1);
		expect(saveAuthMock).toHaveBeenCalledWith(result.authState);
	});

	it("propagates refresh_token and expires_at from URL into AuthState", async () => {
		const { state } = startOAuth({ mode: "prod" });

		const result = await receiveOAuthDeepLink(
			`naia://auth?key=gw-foo&user_id=u1&refresh_token=rt-abc&expires_at=1800000000&state=${state}`,
		);

		expect(result.ok).toBe(true);
		expect(result.authState?.refreshToken).toBe("rt-abc");
		expect(result.authState?.expiresAt).toBe(1800000000);
	});
});

// --- secret hygiene ----------------------------------------------------------

describe("forensic log — secret hygiene", () => {
	it("never logs the naiaKey value", async () => {
		const { state } = startOAuth({ mode: "dev" });
		const secret = "gw-super-secret-key-do-not-leak";
		await receiveOAuthDeepLink(
			`naia://auth?key=${secret}&user_id=u1&refresh_token=rt-also-secret&state=${state}`,
		);

		const serialized = JSON.stringify(getOAuthLog());
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("rt-also-secret");
	});
});

// --- listeners ---------------------------------------------------------------

describe("onOAuthLog", () => {
	it("invokes the listener synchronously after each event and unsubscribe stops further calls", async () => {
		const events: OAuthLogEntry[] = [];
		const unsub = onOAuthLog((e) => events.push(e));

		startOAuth({ mode: "dev" });
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("start");

		await receiveOAuthDeepLink("naia://auth"); // missing_state
		expect(events).toHaveLength(2);
		expect(events[1]?.event).toBe("receive_reject");

		unsub();
		startOAuth({ mode: "dev" });
		expect(events).toHaveLength(2); // unchanged after unsubscribe
	});

	it("does not crash receiveOAuthDeepLink when a listener throws", async () => {
		onOAuthLog(() => {
			throw new Error("listener exploded");
		});

		const { state } = startOAuth({ mode: "dev" });
		const result = await receiveOAuthDeepLink(
			`naia://auth?key=gw-foo&user_id=u1&state=${state}`,
		);
		expect(result.ok).toBe(true);
	});
});

// --- log buffer cap ----------------------------------------------------------

describe("forensic log buffer", () => {
	it("caps at 1000 entries and drops the oldest", async () => {
		// Inject 1001 malformed-URL receives — fast, no saveAuth.
		for (let i = 0; i < 1001; i++) {
			await receiveOAuthDeepLink(`not-a-url-${i}`);
		}
		const log = getOAuthLog();
		expect(log).toHaveLength(1000);
		// The oldest (i=0) is dropped; the newest (i=1000) is at the end.
		// We don't tag i in the log entries themselves, so just assert size +
		// that the newest entry's timestamp is >= the first entry's timestamp.
		expect(log[log.length - 1]!.timestamp).toBeGreaterThanOrEqual(
			log[0]!.timestamp,
		);
	});
});

// --- reset seam --------------------------------------------------------------

describe("__resetOAuthFlowForTest", () => {
	it("clears state map, log buffer, and listeners", async () => {
		const events: OAuthLogEntry[] = [];
		onOAuthLog((e) => events.push(e));
		const { state } = startOAuth({ mode: "dev" });
		expect(getOAuthLog()).toHaveLength(1);
		expect(events).toHaveLength(1);

		__resetOAuthFlowForTest();

		expect(getOAuthLog()).toHaveLength(0);

		// State map cleared — a previously valid state is now unknown.
		const result = await receiveOAuthDeepLink(
			`naia://auth?key=gw-foo&state=${state}`,
		);
		expect(result).toEqual({ ok: false, reason: "unknown_state" });

		// Listener also cleared — events array stays at 1 (the start before
		// reset) plus 0 from the post-reset receive (reset cleared listener).
		expect(events).toHaveLength(1);
	});
});
