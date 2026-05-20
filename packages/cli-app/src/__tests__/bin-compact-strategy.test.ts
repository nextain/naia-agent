// Integration tests for --compact-strategy flag + NAIA_AGENT_COMPACT_STRATEGY env.
// Slice 3-XR-Compact (#47) P2 — strategy interface wiring.
// No real LLM required; we observe exit codes and stderr only.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

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

// Empty all LLM keys so the bin reaches its "no LLM" exit path quickly —
// we want to observe stderr from arg parsing, not LLM calls. Includes the
// post-77a355d `hasLLMConfig()` checks: NAIA_ANYLLM_*, NAIA_MAIN_MODEL,
// OPENAI_BASE_URL (latter alone now triggers hasLLMConfig=true).
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

describe("bin/naia-agent --compact-strategy (Slice 3-XR-Compact P2 / #47)", () => {
	it("accepts --compact-strategy reactive (default — parses cleanly)", () => {
		const r = runBin(["--compact-strategy", "reactive", "hi"]);
		// No LLM configured → exit 3. The point is: stderr must NOT mention
		// an arg-parse error for --compact-strategy.
		expect(r.status).toBe(3);
		expect(r.stderr).not.toContain("--compact-strategy");
		expect(r.stderr).toContain("no LLM provider configured");
	});

	it("accepts --compact-strategy realtime", () => {
		const r = runBin(["--compact-strategy", "realtime", "hi"]);
		expect(r.status).toBe(3);
		expect(r.stderr).not.toContain("--compact-strategy");
	});

	it("accepts --compact-strategy anthropic-native", () => {
		const r = runBin(["--compact-strategy", "anthropic-native", "hi"]);
		expect(r.status).toBe(3);
		expect(r.stderr).not.toContain("--compact-strategy:");
	});

	it("accepts --compact-strategy off", () => {
		const r = runBin(["--compact-strategy", "off", "hi"]);
		expect(r.status).toBe(3);
		expect(r.stderr).not.toContain("--compact-strategy:");
	});

	it("rejects --compact-strategy with no value (exit 3, helpful stderr)", () => {
		const r = runBin(["--compact-strategy"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("--compact-strategy requires a value");
		expect(r.stderr).toContain("reactive|realtime|anthropic-native|off");
	});

	it("rejects --compact-strategy invalid (exit 3, helpful stderr)", () => {
		const r = runBin(["--compact-strategy", "magic"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("unknown value 'magic'");
		expect(r.stderr).toContain("Allowed: reactive|realtime|anthropic-native|off");
	});

	it("env NAIA_AGENT_COMPACT_STRATEGY=realtime is accepted silently", () => {
		const r = runBin(["hi"], { NAIA_AGENT_COMPACT_STRATEGY: "realtime" });
		expect(r.status).toBe(3);
		// No warning, no parse error — env is the source of default truth.
		expect(r.stderr).not.toMatch(/NAIA_AGENT_COMPACT_STRATEGY.*invalid/);
	});

	it("env NAIA_AGENT_COMPACT_STRATEGY=garbage warns and falls back to reactive", () => {
		const r = runBin(["hi"], { NAIA_AGENT_COMPACT_STRATEGY: "garbage" });
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("NAIA_AGENT_COMPACT_STRATEGY='garbage' invalid");
		expect(r.stderr).toContain("using 'reactive'");
	});

	it("CLI flag overrides env (--compact-strategy off beats env=realtime)", () => {
		// We can only assert clean parsing here — actual runtime behavior is
		// covered by the Agent unit tests in @nextain/agent-core.
		const r = runBin(["--compact-strategy", "off", "hi"], {
			NAIA_AGENT_COMPACT_STRATEGY: "realtime",
		});
		expect(r.status).toBe(3);
		expect(r.stderr).not.toMatch(/--compact-strategy:/);
		// The runtime sees `off` (CLI > env). Verified at the core level
		// (Agent.#strategy === "off" → maybeCompact short-circuits) — see
		// packages/core/src/__tests__/agent-compaction-strategy.test.ts.
	});
});
