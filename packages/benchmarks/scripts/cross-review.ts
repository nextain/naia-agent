#!/usr/bin/env -S pnpm exec tsx
/**
 * 4-AI cross-review wrapper — Slice v2 Ralph 루프의 review step.
 *
 * 같은 prompt 를 GLM HTTP / opencode / codex / gemini 4개 AI 에게 동시 전달,
 * 각 응답을 markdown 으로 출력. cli-judge.ts 의 spawn pattern 그대로 차용
 * (smoke:judges:live 가 4/4 LIVE 인 path 와 동일).
 *
 * Usage:
 *   source /home/luke/alpha-adk/data-private/llm-keys/llm.env
 *   pnpm --filter @nextain/agent-benchmarks tsx scripts/cross-review.ts <prompt-file>
 */

import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(HERE, "..", "reports");
const TIMEOUT_MS = 180_000;

interface AIResponse {
	readonly name: string;
	readonly content: string;
	readonly latencyMs: number;
	readonly status: "ok" | "infra-error";
	readonly error?: string;
}

async function callGLM(prompt: string): Promise<AIResponse> {
	const t0 = performance.now();
	const apiKey = process.env.GLM_API_KEY;
	if (!apiKey) {
		return {
			name: "glm",
			content: "",
			latencyMs: 0,
			status: "infra-error",
			error: "GLM_API_KEY not set",
		};
	}
	try {
		const res = await fetch(
			"https://open.bigmodel.cn/api/paas/v4/chat/completions",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: process.env.GLM_MODEL ?? "glm-4.5-flash",
					messages: [{ role: "user", content: prompt }],
					temperature: 0,
					max_tokens: 3000,
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		);
		const body = (await res.json()) as {
			choices?: {
				message?: { content?: string; reasoning_content?: string };
			}[];
		};
		const msg = body.choices?.[0]?.message ?? {};
		const content = (msg.content ?? "").trim() || (msg.reasoning_content ?? "").trim();
		return {
			name: "glm",
			content: content || "(empty)",
			latencyMs: performance.now() - t0,
			status: content ? "ok" : "infra-error",
			...(content ? {} : { error: "empty content + empty reasoning" }),
		};
	} catch (err) {
		return {
			name: "glm",
			content: "",
			latencyMs: performance.now() - t0,
			status: "infra-error",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

interface CliSpec {
	readonly name: string;
	readonly bin: string;
	readonly leadingArgs: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

const CLI_SPECS: CliSpec[] = [
	{
		name: "opencode",
		bin: "opencode",
		leadingArgs: ["run", "--pure"],
	},
	{
		name: "codex",
		bin: "codex",
		leadingArgs: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"],
	},
	{
		name: "gemini",
		bin: "gemini",
		leadingArgs: ["--skip-trust", "-p"],
		env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
	},
];

function callCli(spec: CliSpec, prompt: string): Promise<AIResponse> {
	return new Promise((resolve) => {
		const t0 = performance.now();
		const proc = spawn(spec.bin, [...spec.leadingArgs, prompt], {
			env: { ...process.env, ...(spec.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
		}, TIMEOUT_MS);
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			const latencyMs = performance.now() - t0;
			const cleaned = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
			if (code !== 0) {
				resolve({
					name: spec.name,
					content: "",
					latencyMs,
					status: "infra-error",
					error: `exit ${code}: ${stderr.slice(-200) || stdout.slice(-200)}`,
				});
			} else {
				resolve({
					name: spec.name,
					content: cleaned || "(empty)",
					latencyMs,
					status: cleaned ? "ok" : "infra-error",
					...(cleaned ? {} : { error: "empty stdout" }),
				});
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				name: spec.name,
				content: "",
				latencyMs: performance.now() - t0,
				status: "infra-error",
				error: err.message,
			});
		});
	});
}

async function main(): Promise<void> {
	const promptFile = process.argv[2];
	if (!promptFile) {
		process.stderr.write("Usage: tsx cross-review.ts <prompt-file>\n");
		process.exit(2);
	}
	const prompt = await readFile(promptFile, "utf-8");
	process.stderr.write(
		`[cross-review] prompt ${prompt.length} chars → 4 AIs in parallel\n`,
	);

	const responses = await Promise.all([
		callGLM(prompt),
		...CLI_SPECS.map((s) => callCli(s, prompt)),
	]);

	// Render markdown
	const date = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
	const lines: string[] = [];
	lines.push(`# Cross-Review — ${date}`);
	lines.push("");
	lines.push(`**Prompt size**: ${prompt.length} chars`);
	lines.push(`**AIs queried**: ${responses.length}`);
	const okCount = responses.filter((r) => r.status === "ok").length;
	lines.push(`**Valid responses**: ${okCount}/${responses.length}`);
	lines.push("");
	for (const r of responses) {
		lines.push(`## ${r.name} — ${r.status} (${r.latencyMs.toFixed(0)}ms)`);
		lines.push("");
		if (r.status === "ok") {
			lines.push("```");
			lines.push(r.content);
			lines.push("```");
		} else {
			lines.push(`*Infra error*: ${r.error ?? "(unknown)"}`);
		}
		lines.push("");
	}

	await mkdir(REPORTS_DIR, { recursive: true });
	const reportPath = join(REPORTS_DIR, `cross-review-${date}.md`);
	await writeFile(reportPath, lines.join("\n"), "utf-8");
	process.stderr.write(`[cross-review] report → ${reportPath}\n`);
	process.stdout.write(lines.join("\n"));
}

main().catch((err: unknown) => {
	process.stderr.write(
		`[cross-review] FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
