/**
 * CLI-based judges — codex, opencode, gemini — Slice 3-XR-Compact #48.
 *
 * Each judge spawns the corresponding CLI as a subprocess with `which`-based
 * lookup, sends the prompt on argv (no stdin pipe TTY surprises), captures
 * stdout, and parses with the shared `parseJudgeReply`. Failures route
 * through `infraError` so the ensemble can majority-vote on valid judges.
 *
 * Per `feedback_pi_substrate_not_glm_only_2026_05_20`: real multi-tool
 * ensemble, not single-judge.
 */

import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import type { Judge, JudgeInput, JudgeResult } from "./types.js";
import { buildJudgePrompt, parseJudgeReply } from "./prompt.js";

export interface CliSpec {
	readonly name: string;
	readonly bin: string;
	/** Args BEFORE the prompt. Prompt is appended as the final argv. */
	readonly leadingArgs: readonly string[];
	/** Environment overrides (e.g. trust-mode flags). */
	readonly env?: Readonly<Record<string, string>>;
}

export const CLI_SPECS: Record<"codex" | "opencode" | "gemini" | "claude", CliSpec> = {
	codex: {
		name: "codex",
		bin: "codex",
		leadingArgs: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"],
	},
	opencode: {
		name: "opencode",
		bin: "opencode",
		leadingArgs: ["run", "--pure"],
	},
	gemini: {
		name: "gemini",
		bin: "gemini",
		leadingArgs: ["--skip-trust", "-p"],
		env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
	},
	// Claude Code non-interactive print mode. Self-contained text judge (no tools
	// needed); consumes the Claude subscription so callers gate it
	// (NAIA_JUDGE_ENSEMBLE).
	claude: {
		name: "claude",
		bin: "claude",
		leadingArgs: ["-p"],
	},
};

export async function runCli(spec: CliSpec, prompt: string, timeoutMs: number): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}> {
	return new Promise((resolve) => {
		const args = [...spec.leadingArgs, prompt];
		const proc = spawn(spec.bin, args, {
			env: { ...process.env, ...(spec.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
		}, timeoutMs);
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				stdout,
				stderr: `${stderr}\n[spawn error] ${err.message}`,
				exitCode: -1,
				timedOut: false,
			});
		});
	});
}

function makeCliJudge(specKey: keyof typeof CLI_SPECS): Judge {
	const spec = CLI_SPECS[specKey];
	return async (input: JudgeInput): Promise<JudgeResult> => {
		const t0 = performance.now();
		const timeoutMs = input.timeoutMs ?? 60_000;
		const prompt = buildJudgePrompt(input);
		try {
			const result = await runCli(spec, prompt, timeoutMs);
			const latencyMs = performance.now() - t0;
			if (result.timedOut) {
				return {
					infraError: `${spec.name} timed out after ${timeoutMs}ms`,
					latencyMs,
				};
			}
			if (result.exitCode !== 0) {
				return {
					infraError: `${spec.name} exited ${result.exitCode}: ${result.stderr.slice(-200) || result.stdout.slice(-200)}`,
					latencyMs,
				};
			}
			// Strip ANSI escapes (some CLIs colorize stdout even non-TTY).
			const cleaned = result.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
			const verdict = parseJudgeReply(cleaned, latencyMs);
			if (!verdict) {
				return {
					infraError: `${spec.name} reply unparseable (${cleaned.length} chars): ${cleaned.slice(-200)}`,
					latencyMs,
				};
			}
			return verdict;
		} catch (err) {
			return {
				infraError: `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`,
				latencyMs: performance.now() - t0,
			};
		}
	};
}

export const codexJudge = makeCliJudge("codex");
export const opencodeJudge = makeCliJudge("opencode");
export const geminiJudge = makeCliJudge("gemini");
export const claudeJudge = makeCliJudge("claude");
