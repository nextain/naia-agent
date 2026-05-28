// #337 Phase 10 — S115/S116 cross-restart auth persistence integration tests.
//
// Scope: exercises the full auth IPC handler stack (auth-store + keyring +
// crypto-envelope) and simulates the cross-process restart boundary by
// resetting the in-memory caches between "boots". The file-backed test
// keyring persists the master password to disk across the simulated
// restart, exactly mirroring how the native OS keyring would behave for a
// real child-process spawn.
//
// Why not spawn a child process: the production agent binary
// (`bin/naia-agent.ts`) imports `@nextain/agent-runtime` which resolves to
// `packages/runtime/dist/index.js`. The dist is stale relative to src (the
// codegraph pre-existing TS errors block `tsc --build`), so a child-process
// spawn would fail on `createCodeGraphExecutor` missing from dist. The
// auth-handler code path under test does NOT touch any of that — it's
// purely auth-store + keyring + crypto-envelope, all of which we can drive
// from src directly. The "simulated restart" via cache reset is the
// strongest test we can ship without first repairing the unrelated
// codegraph build issue.
//
// What's covered (S115/S116 acceptance per task brief):
//   * S115: dev login → restart → auth_query still reports loggedIn:true,
//     userId preserved, naiaKey never leaks to the response.
//   * S116: dev+prod logins → mode-swap restart → both queries still
//     report loggedIn:true; the two encrypted blobs are distinct on disk.
//
// What's not covered (and where it lives):
//   * The bin dispatcher's `auth_changed` stdout emission — covered by the
//     handler unit tests + dispatcher inspection in `ipc-handlers.test.ts`.
//   * Real fetch behaviour through `lab_proxy_request` — Phase 5a/7 unit
//     tests cover the 401 retry + Bearer header injection.
//   * wdio webview cross-restart — explicitly out of scope (#328).

import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	__setKeyringEnvForTest,
	__setKeyringForTest,
} from "../../utils/keyring.js";
import { __resetAuthStoreForTest } from "../../utils/auth-store.js";
import { __resetOAuthFlowForTest } from "../../utils/oauth-flow.js";
import { __resetRefreshForTest } from "../refresh.js";

import {
	handleAuthQuery,
	handleAuthReceived,
	handleAuthStart,
} from "../ipc-handlers.js";

// --- fixtures ---------------------------------------------------------------

const ORIG_ADK_PATH = process.env.NAIA_ADK_PATH;
const ORIG_MODE = process.env.NAIA_AGENT_MODE;
const ORIG_KEYRING_FILE = process.env.NAIA_KEYRING_TEST_FILE;

let adkRoot: string;
let keyringFile: string;

beforeEach(async () => {
	adkRoot = await mkdtemp(path.join(tmpdir(), "naia-auth-restart-"));
	keyringFile = path.join(adkRoot, ".test-keyring.json");
	process.env.NAIA_ADK_PATH = adkRoot;
	process.env.NAIA_KEYRING_TEST_FILE = keyringFile;
	// Force the selection logic to pick the file-backed test backend by
	// clearing any cached injection from sibling tests.
	__setKeyringForTest(undefined);
	__setKeyringEnvForTest(undefined);
	__resetAuthStoreForTest();
	__resetOAuthFlowForTest();
	__resetRefreshForTest();
});

afterEach(async () => {
	if (ORIG_ADK_PATH !== undefined) process.env.NAIA_ADK_PATH = ORIG_ADK_PATH;
	else delete process.env.NAIA_ADK_PATH;
	if (ORIG_MODE !== undefined) process.env.NAIA_AGENT_MODE = ORIG_MODE;
	else delete process.env.NAIA_AGENT_MODE;
	if (ORIG_KEYRING_FILE !== undefined)
		process.env.NAIA_KEYRING_TEST_FILE = ORIG_KEYRING_FILE;
	else delete process.env.NAIA_KEYRING_TEST_FILE;
	__setKeyringForTest(undefined);
	__setKeyringEnvForTest(undefined);
	await rm(adkRoot, { recursive: true, force: true });
});

/**
 * Simulate the cross-process restart boundary: wipe all in-process caches
 * that a fresh child-process spawn would naturally lack. The file-backed
 * keyring + the encrypted auth file on disk are preserved (they're the
 * cross-restart contract under test).
 */
function simulateRestart(): void {
	__setKeyringForTest(undefined);
	__resetAuthStoreForTest();
	__resetOAuthFlowForTest();
	__resetRefreshForTest();
}

function makeDeepLink(state: string, key: string, userId = "naia_test"): string {
	const params = new URLSearchParams();
	params.set("key", key);
	params.set("user_id", userId);
	params.set("state", state);
	return `naia://auth?${params.toString()}`;
}

async function loginViaHandlers(
	mode: "dev" | "prod",
	naiaKey: string,
): Promise<void> {
	const start = handleAuthStart({ mode });
	const received = await handleAuthReceived({
		deepLinkUrl: makeDeepLink(start.state, naiaKey),
	});
	if (!received.ok) {
		throw new Error(`auth_received failed: ${received.reason}`);
	}
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

// --- S115 — restart preserves login (single mode) ---------------------------

describe("#337 Phase 10 — S115 restart preserves login (single mode)", () => {
	it("dev login survives a simulated process restart", async () => {
		// "Process #1" — boot, login, observe in-process auth_query, then exit.
		await loginViaHandlers("dev", "gw-restart-test-001");

		// Same-process round-trip works before the simulated restart.
		const preRestart = await handleAuthQuery({ mode: "dev" });
		expect(preRestart.loggedIn).toBe(true);
		expect(preRestart.userId).toBe("naia_test");
		expect(JSON.stringify(preRestart)).not.toContain("gw-restart-test-001");

		// Encrypted file exists on disk and the naiaKey is NOT plaintext-leaked.
		const devBlob = path.join(adkRoot, "naia-settings", "auth", "dev.json.enc");
		expect(await fileExists(devBlob)).toBe(true);
		const blobBytes = await readFile(devBlob);
		expect(blobBytes.length).toBeGreaterThan(0);
		expect(blobBytes.toString("utf8")).not.toContain("gw-restart-test-001");

		// --- Simulated restart boundary ---------------------------------------
		simulateRestart();

		// "Process #2" — cold boot. The file-backed keyring persists the master
		// password across the boundary, the encrypted blob is still on disk, and
		// `loadAuth` must successfully decrypt and return the original state.
		const postRestart = await handleAuthQuery({ mode: "dev" });
		expect(postRestart.loggedIn).toBe(true);
		expect(postRestart.userId).toBe("naia_test");
		// Critical: naiaKey never leaks to the IPC response after restart either.
		expect(JSON.stringify(postRestart)).not.toContain("gw-restart-test-001");
	});

	it("logged-out blob is also preserved as logged-out after restart", async () => {
		// Negative: never logged in → restart → still logged out (sanity).
		const before = await handleAuthQuery({ mode: "dev" });
		expect(before).toEqual({ loggedIn: false });

		simulateRestart();

		const after = await handleAuthQuery({ mode: "dev" });
		expect(after).toEqual({ loggedIn: false });
	});
});

// --- S116 — dev/prod mode swap, both survive --------------------------------

describe("#337 Phase 10 — S116 dev/prod mode swap survives", () => {
	it("dev + prod logins both decrypt after a simulated restart in each mode", async () => {
		// "Process #1" — dev mode + login.
		process.env.NAIA_AGENT_MODE = "dev";
		await loginViaHandlers("dev", "gw-dev-key-A");

		// "Process #2" — switch to prod mode + login. Simulate the restart by
		// wiping caches; same on-disk keyring file → same master password, so
		// the prod blob can be encrypted with the same key. Different mode →
		// different file, different plaintext → different ciphertext.
		simulateRestart();
		process.env.NAIA_AGENT_MODE = "prod";
		await loginViaHandlers("prod", "gw-prod-key-B");

		const devBlob = path.join(adkRoot, "naia-settings", "auth", "dev.json.enc");
		const prodBlob = path.join(
			adkRoot,
			"naia-settings",
			"auth",
			"prod.json.enc",
		);
		expect(await fileExists(devBlob)).toBe(true);
		expect(await fileExists(prodBlob)).toBe(true);

		// The two encrypted blobs MUST differ — same master password but
		// different nonce + different plaintext payload.
		const devBytes = await readFile(devBlob);
		const prodBytes = await readFile(prodBlob);
		expect(Buffer.compare(devBytes, prodBytes)).not.toBe(0);

		// And neither blob leaks its respective naiaKey in plaintext.
		expect(devBytes.toString("utf8")).not.toContain("gw-dev-key-A");
		expect(prodBytes.toString("utf8")).not.toContain("gw-prod-key-B");

		// "Process #3" — restart in dev mode, dev login still valid; cross-mode
		// query (prod from a dev-mode process) also returns true because the
		// handler accepts an explicit mode arg.
		simulateRestart();
		process.env.NAIA_AGENT_MODE = "dev";

		const devQuery = await handleAuthQuery({ mode: "dev" });
		expect(devQuery.loggedIn).toBe(true);
		expect(JSON.stringify(devQuery)).not.toContain("gw-dev-key-A");

		const prodFromDev = await handleAuthQuery({ mode: "prod" });
		expect(prodFromDev.loggedIn).toBe(true);
		expect(JSON.stringify(prodFromDev)).not.toContain("gw-prod-key-B");

		// "Process #4" — restart in prod mode, prod login still valid.
		simulateRestart();
		process.env.NAIA_AGENT_MODE = "prod";

		const prodQuery = await handleAuthQuery({ mode: "prod" });
		expect(prodQuery.loggedIn).toBe(true);
		expect(JSON.stringify(prodQuery)).not.toContain("gw-prod-key-B");

		// Cross-check: dev login still queryable from a prod-mode process.
		const devFromProd = await handleAuthQuery({ mode: "dev" });
		expect(devFromProd.loggedIn).toBe(true);
		expect(JSON.stringify(devFromProd)).not.toContain("gw-dev-key-A");
	});
});
