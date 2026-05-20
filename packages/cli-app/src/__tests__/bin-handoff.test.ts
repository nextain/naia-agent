// Slice 3-XR-Handoff (#50) P4 — bin flag integration.
// `--handoff-out <path>` / `--handoff-in <path>` parsing + missing-value errors.
// Full export/import semantics are covered by the runtime P5 loop tests.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");
const binPath = resolve(repoRoot, "bin/naia-agent.ts");

function findTsxCli(): string {
	const pnpmDir = resolve(repoRoot, "node_modules/.pnpm");
	if (existsSync(pnpmDir)) {
		for (const entry of readdirSync(pnpmDir)) {
			if (entry.startsWith("tsx@")) {
				const candidate = resolve(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
				if (existsSync(candidate)) return candidate;
			}
		}
	}
	const hoisted = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
	if (existsSync(hoisted)) return hoisted;
	throw new Error("tsx dist/cli.mjs not found");
}

const tsxCli = findTsxCli();

// Same NO_LLM_ENV pattern as bin-compact-strategy.test.ts.
const NO_LLM_ENV = {
	ANTHROPIC_API_KEY: "",
	OPENAI_API_KEY: "",
	OPENAI_BASE_URL: "",
	GLM_API_KEY: "",
	VERTEX_PROJECT_ID: "",
	VERTEX_REGION: "",
	NAIA_ANYLLM_API_KEY: "",
	NAIA_ANYLLM_BASE_URL: "",
	NAIA_MAIN_MODEL: "",
	NAIA_AGENT_ENV: "/dev/null",
	NAIA_AGENT_CONFIG: "/dev/null",
	NAIA_ADK_PATH: "",
} as const;

function runBin(args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 15_000) {
	return spawnSync(process.execPath, [tsxCli, binPath, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...NO_LLM_ENV, ...env },
		encoding: "utf8",
		timeout: timeoutMs,
	});
}

describe("bin/naia-agent --handoff-out / --handoff-in (Slice 3-XR-Handoff #50 P4)", () => {
	it("HF-BIN-01: --handoff-out parses cleanly (with prompt, no LLM → exit 3)", () => {
		const r = runBin([
			"--handoff-out",
			"/tmp/test-handoff.json",
			"--compact-strategy",
			"reactive",
			"hi",
		]);
		expect(r.status).toBe(3);
		expect(r.stderr).not.toContain("--handoff-out:");
		expect(r.stderr).not.toContain("--compact-strategy:");
	});

	it("HF-BIN-02: --handoff-in parses cleanly", () => {
		const r = runBin([
			"--handoff-in",
			"/tmp/test-handoff.json",
			"hi",
		]);
		expect(r.status).toBe(3);
		expect(r.stderr).not.toContain("--handoff-in:");
	});

	it("HF-BIN-03: --handoff-out without path → usage error exit 3", () => {
		const r = runBin(["--handoff-out"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("--handoff-out requires a path");
	});

	it("HF-BIN-04: --handoff-in without path → usage error exit 3", () => {
		const r = runBin(["--handoff-in"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("--handoff-in requires a path");
	});

	it("HF-BIN-05: --handoff-in with non-existent file → warning to stderr, continues", () => {
		// Path doesn't exist; bin should warn + continue (still hit no-LLM exit 3).
		const r = runBin([
			"--handoff-in",
			"/tmp/this-blob-does-not-exist-xyz.json",
			"hi",
		]);
		expect(r.status).toBe(3);
		// Warning should mention the path + "read failed" or similar.
		expect(r.stderr).toMatch(/--handoff-in.*\/tmp\/this-blob-does-not-exist-xyz\.json/);
	});

	it("HF-BIN-06: --handoff-in with invalid JSON → warning + continues (no crash)", () => {
		const tmp = mkdtempSync(join(tmpdir(), "handoff-bin-"));
		const badPath = join(tmp, "bad.json");
		writeFileSync(badPath, "{ not valid json", "utf8");
		try {
			const r = runBin(["--handoff-in", badPath, "hi"]);
			expect(r.status).toBe(3);
			// Either a JSON parse error surfaces OR the version!=1 warning fires.
			expect(r.stderr).toMatch(/--handoff-in.*(read failed|HandoffBlob|JSON)/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("HF-BIN-07: --handoff-in with version!=1 blob → 'not a valid HandoffBlob' warning", () => {
		const tmp = mkdtempSync(join(tmpdir(), "handoff-bin-"));
		const wrongVerPath = join(tmp, "wrongver.json");
		writeFileSync(
			wrongVerPath,
			JSON.stringify({ version: 999, sessionId: "x" }),
			"utf8",
		);
		try {
			const r = runBin(["--handoff-in", wrongVerPath, "hi"]);
			expect(r.status).toBe(3);
			expect(r.stderr).toContain("not a valid HandoffBlob");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
