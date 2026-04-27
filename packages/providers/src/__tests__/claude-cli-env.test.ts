import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCliClient } from "../claude-cli.js";

/**
 * Day 5.1 — ClaudeCliClient env allowlist tests.
 *
 * Cross-review (Day 4.3 Paranoid P0-3 fix) — verify subprocess env scrubbing
 * uses explicit allowlist, NOT spread-then-delete pattern. Risk vectors:
 *   - LD_PRELOAD trojan
 *   - LD_LIBRARY_PATH injection
 *   - DYLD_INSERT_LIBRARIES (macOS)
 *   - PATH manipulation (only PATH allowed, but value forwarded as-is)
 *   - ANTHROPIC_API_KEY leak
 *
 * Strategy: spy on `child_process.spawn` to capture env passed to subprocess.
 */

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual };
});

import * as cp from "node:child_process";

describe("ClaudeCliClient — env allowlist (Day 5.1 Paranoid P0-3 fix)", () => {
	let savedEnv: NodeJS.ProcessEnv;
	let spawnSpy: ReturnType<typeof vi.spyOn>;
	let capturedEnv: NodeJS.ProcessEnv = {};

	beforeEach(() => {
		savedEnv = { ...process.env };
		capturedEnv = {};
		// Spy spawn to capture env, return mock child that exits immediately.
		spawnSpy = vi.spyOn(cp, "spawn").mockImplementation((_cmd: any, _args: any, options: any) => {
			capturedEnv = options?.env ?? {};
			// Mock child — minimal implementation to satisfy the type.
			const fakeChild: any = {
				stdin: { write: () => true, end: () => undefined },
				stdout: (async function* () { yield ""; })(),
				killed: false,
				kill: () => true,
				on: () => fakeChild,
			};
			return fakeChild;
		});
	});

	afterEach(() => {
		process.env = savedEnv;
		spawnSpy.mockRestore();
	});

	it("LD_PRELOAD is NOT forwarded to subprocess", async () => {
		process.env["LD_PRELOAD"] = "/tmp/evil.so";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		const iter = client.stream({ messages: [{ role: "user", content: "hi" }] });
		try {
			// Drain the iterator until spawn is called and we capture env.
			for await (const _ of iter) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {
			// mock child may throw — we only care about env capture
		}
		expect(capturedEnv["LD_PRELOAD"]).toBeUndefined();
	});

	it("LD_LIBRARY_PATH is NOT forwarded", async () => {
		process.env["LD_LIBRARY_PATH"] = "/tmp/evil";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["LD_LIBRARY_PATH"]).toBeUndefined();
	});

	it("DYLD_INSERT_LIBRARIES is NOT forwarded (macOS)", async () => {
		process.env["DYLD_INSERT_LIBRARIES"] = "/tmp/evil.dylib";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["DYLD_INSERT_LIBRARIES"]).toBeUndefined();
	});

	it("ANTHROPIC_API_KEY is NOT forwarded", async () => {
		process.env["ANTHROPIC_API_KEY"] = "sk-secret";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
	});

	it("CLAUDECODE is NOT forwarded", async () => {
		process.env["CLAUDECODE"] = "1";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["CLAUDECODE"]).toBeUndefined();
	});

	it("PATH IS forwarded (binary resolution)", async () => {
		process.env["PATH"] = "/usr/bin:/bin";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["PATH"]).toBe("/usr/bin:/bin");
	});

	it("HOME IS forwarded (~/.claude config)", async () => {
		process.env["HOME"] = "/home/test";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["HOME"]).toBe("/home/test");
	});

	it("CLAUDE_CODE_MAX_OUTPUT_TOKENS overridden by client option", async () => {
		const client = new ClaudeCliClient({
			defaultModel: "claude-opus-4-7",
			maxOutputTokens: "16000",
		});
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]).toBe("16000");
	});

	it("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC defaults to '1'", async () => {
		delete process.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"];
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
	});

	it("arbitrary unknown env var is NOT forwarded", async () => {
		process.env["MY_RANDOM_VAR"] = "leaked";
		const client = new ClaudeCliClient({ defaultModel: "claude-opus-4-7" });
		try {
			for await (const _ of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
				if (Object.keys(capturedEnv).length > 0) break;
			}
		} catch {}
		expect(capturedEnv["MY_RANDOM_VAR"]).toBeUndefined();
	});
});
