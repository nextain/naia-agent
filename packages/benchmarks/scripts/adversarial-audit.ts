#!/usr/bin/env -S pnpm exec tsx
/**
 * R7 Phase D — Adversarial code/test audit harness.
 *
 * Replaces the R1-R5 "cross-review verdict" pattern with the R6/audit pattern:
 *   - reviewers are told to OPEN AND READ specific files
 *   - they hunt RAW patterns (sentinels, divergent paths, dropped probes, etc.)
 *   - no pre-defined flaw IDs to validate — only observed code behavior
 *   - file:line citations required
 *
 * Usage:
 *   source /home/luke/alpha-adk/data-private/llm-keys/llm.env
 *   pnpm --filter @nextain/agent-benchmarks exec tsx scripts/adversarial-audit.ts \
 *     --target "<short label, e.g. R7-Phase-D>" \
 *     --files <file1>,<file2>,...
 *
 * Output: same shape as cross-review.ts (multi-AI markdown report in
 * `packages/benchmarks/reports/cross-review-<timestamp>.md`).
 */

import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(HERE, "..", "reports");
const REPO_ROOT = join(HERE, "..", "..", "..");
const TIMEOUT_MS = 180_000;

interface AIResponse {
	readonly name: string;
	readonly content: string;
	readonly latencyMs: number;
	readonly status: "ok" | "infra-error";
	readonly error?: string;
}

interface AuditArgs {
	readonly target: string;
	readonly files: readonly string[];
}

function parseArgs(argv: readonly string[]): AuditArgs | { error: string } {
	let target: string | undefined;
	let filesCsv: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--target" && i + 1 < argv.length) {
			target = argv[i + 1];
			i++;
		} else if (argv[i] === "--files" && i + 1 < argv.length) {
			filesCsv = argv[i + 1];
			i++;
		}
	}
	if (!target) return { error: "--target <label> required" };
	if (!filesCsv) return { error: "--files <comma-separated paths> required" };
	const files = filesCsv.split(",").map((f) => f.trim()).filter(Boolean);
	return { target, files };
}

/**
 * Build the R6/audit-mode prompt for the given target. This is the
 * primary deliverable of Phase D — every audit goes through this
 * template, no per-round drift.
 */
function buildAuditPrompt(target: string, files: readonly string[]): string {
	return `# CODE / TEST ADVERSARIAL AUDIT — ${target}

## Audit mode (NOT verdict mode)

Read source. Run the harness in your head. Find broken / meaningless
measurement mechanics. Do NOT trace given flaw IDs — those framings are
banned (they caused R1-R5 to miss obvious patterns for 5 rounds).

You are NOT validating any prior claim. You are reading the code and
reporting what you observe.

## Files to read in FULL

${files.map((f, i) => `${i + 1}. ${f}`).join("\n")}

(Open each file. Read it. Do not skim.)

## Raw patterns to hunt — examples (not exhaustive)

1. **Sentinel / placeholder returns** (\`return undefined\`,
   \`return ""\`, no-op early-return, \`if (false)\`, \`throw new Error("TODO")\`)
   in what the prompt claims are real branches. If a branch is a
   sentinel, the corresponding result row is fabricated.

2. **Two strategies / branches sharing a code path** producing identical
   visible output — yet reported as separate result rows.

3. **Probes asking about facts not in the strategy's responsibility window.**
   If the asked fact lives in the preserved tail or a turn the strategy
   never touched, the probe does NOT stress that strategy.

4. **Visible-context divergence between callers.** If two call sites
   "share" a function but pass different inputs (e.g. different
   currentTurn), the contract is broken.

5. **Schema laxness.** \`validateFixture\` accepting almost anything;
   silent fallback for missing fields hides authoring bugs.

6. **Hard-coded constants that should be config.** Two literals with
   the same value count as 1 drift waiting to happen.

7. **Tests that mock the thing they're supposed to verify.**

8. **N=1 statistical power.** Single judge timeout flips PASS↔FAIL.

9. **Asymmetric truncation / cap rules.** Some strategies exempted
   from a "uniform" cap.

10. **Category mismatch.** Judge prompt asks for X but criterion asks
    for Y.

## Deliverable format

\`\`\`
SECTION 1 — FINDINGS (3-15 items)
  Finding #N
  Severity: HALT (measurement meaningless) | MAJOR (results misleading) | MINOR (cosmetic)
  Location: file:line
  What code does (1-2 sentences, NOT what comments claim):
  Reproduction scenario:
  Why broken:

SECTION 2 — TRUST VERDICT
  For each strategy / measurement row, classify:
  (a) TRUST — actual signal observed
  (b) DISTRUST — measurement artefact
  (c) UNKNOWN — cannot determine from code alone
  Be specific. Cite cells / file paths.

SECTION 3 — NEXT REQUIRED WORK
  Ordered list. What MUST happen before any number is published.

SECTION 4 — IF YOU WERE THE AUTHOR
  In 5-10 bullets, what would you tear down / rebuild?
\`\`\`

## Bias warning

You are encouraged to conclude that ANY proposed feature is currently
broken. We will not push back. We want the audit truth, not a thumbs-up.

If the code is genuinely sound at some point, say so — but cite WHY.

---

Repo: \`${REPO_ROOT}\`
Branch: \`migration/slice-compact-v2\`.
`;
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
					max_tokens: 4000,
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
		// R7 Phase D: workspace-write so codex can actually read files.
		// read-only often timed out at 180s without producing stdout.
		leadingArgs: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"],
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
			cwd: REPO_ROOT,
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
					error: `exit ${code}: ${stderr.slice(-300) || stdout.slice(-300)}`,
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
	const argv = process.argv.slice(2);
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		process.stderr.write(
			`adversarial-audit: ${parsed.error}\n` +
				`usage: adversarial-audit.ts --target <label> --files <f1>,<f2>,...\n`,
		);
		process.exit(2);
	}
	const { target, files } = parsed;

	// Validate files exist
	for (const f of files) {
		const abs = isAbsolute(f) ? f : join(REPO_ROOT, f);
		try {
			await readFile(abs, "utf-8");
		} catch (err) {
			process.stderr.write(
				`adversarial-audit: file not found: ${f}\n`,
			);
			process.exit(2);
		}
	}

	const prompt = buildAuditPrompt(target, files);
	process.stderr.write(
		`[audit] target=${target}, files=${files.length}, prompt=${prompt.length} chars\n` +
			`[audit] dispatching to GLM + ${CLI_SPECS.length} CLI judges in parallel\n`,
	);

	const responses = await Promise.all([
		callGLM(prompt),
		...CLI_SPECS.map((s) => callCli(s, prompt)),
	]);

	// Render markdown
	const date = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
	const lines: string[] = [];
	lines.push(`# Adversarial Audit — ${target} — ${date}`);
	lines.push("");
	lines.push(`**Files audited**: ${files.length}`);
	lines.push(`**Prompt size**: ${prompt.length} chars`);
	lines.push(`**AIs queried**: ${responses.length}`);
	const okCount = responses.filter((r) => r.status === "ok").length;
	lines.push(`**Valid responses**: ${okCount}/${responses.length}`);
	lines.push("");
	lines.push("## Files");
	lines.push("");
	for (const f of files) {
		lines.push(`- \`${f}\``);
	}
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
	const reportPath = join(REPORTS_DIR, `adversarial-audit-${date}.md`);
	await writeFile(reportPath, lines.join("\n"), "utf-8");
	process.stderr.write(`\n[audit] report → ${reportPath}\n`);
	process.stdout.write(lines.join("\n"));
}

main().catch((err: unknown) => {
	process.stderr.write(
		`[audit] FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
