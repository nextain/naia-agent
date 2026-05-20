#!/usr/bin/env -S pnpm exec tsx
/**
 * LIVE smoke for the 4-judge ensemble — Slice 3-XR-Compact #48.
 *
 * Runs ONE sample probe against {GLM, opencode, codex, gemini} concurrently
 * and prints each judge's verdict, latency, and infra-error reason. Use to
 * verify the user's local environment actually reaches all four providers
 * before kicking off a full 10-fixture measurement.
 *
 * Usage:
 *   pnpm --filter @nextain/agent-benchmarks smoke:judges:live
 *
 * Prerequisites:
 *   - GLM_API_KEY in process.env (or ~/.naia-agent/.env loaded by the caller)
 *   - codex / opencode / gemini CLIs on PATH (brew / native install)
 *
 * Exits 0 if at least 2/4 judges return a real verdict (matches ensemble's
 * "non-unreliable" threshold). Otherwise exits 1 with a per-judge summary.
 */

import {
	defaultEnsemble,
	isInfraError,
	runEnsemble,
} from "../src/judges/index.js";

const SAMPLE = {
	question: "What was the customer's order number and refund eligibility?",
	response:
		"Per the conversation, Order #A-7421 from Jane Doe qualifies under the 30-day defective-item policy; refund goes to Visa ending 4291.",
	criterion:
		"The response correctly mentions order number #A-7421 AND indicates eligibility/qualification for refund.",
	timeoutMs: 45_000,
} as const;

async function main(): Promise<number> {
	process.stderr.write("[smoke:judges] running 4-judge ensemble on 1 sample probe...\n");
	const verdict = await runEnsemble({ judges: defaultEnsemble }, SAMPLE);

	process.stdout.write("\n=== Per-judge results ===\n");
	for (const [name, result] of Object.entries(verdict.perJudge)) {
		if (isInfraError(result)) {
			process.stdout.write(
				`  ${name.padEnd(10)} INFRA  (${result.latencyMs.toFixed(0)}ms) ${result.infraError.slice(0, 200)}\n`,
			);
		} else {
			process.stdout.write(
				`  ${name.padEnd(10)} ${result.pass ? "PASS " : "FAIL "} (${result.latencyMs.toFixed(0)}ms) ${result.reason}\n`,
			);
		}
	}

	process.stdout.write("\n=== Ensemble verdict ===\n");
	process.stdout.write(
		`  pass=${verdict.pass}  valid=${verdict.validCount}/${Object.keys(verdict.perJudge).length}  infra=${verdict.infraErrorCount}  unreliable=${verdict.unreliable}\n`,
	);

	// Pass criterion: at least 2 judges must return a real verdict (non-infra).
	if (verdict.validCount < 2) {
		process.stderr.write(
			`\n[smoke:judges] FAIL — only ${verdict.validCount}/4 judges returned a real verdict.\n` +
				`  Check GLM_API_KEY (~/.naia-agent/.env), codex/opencode/gemini CLI installs, and any sandbox/TTY warnings above.\n`,
		);
		return 1;
	}
	process.stderr.write(
		`\n[smoke:judges] OK — ${verdict.validCount}/4 judges live. Ensemble is reliable enough to run full benchmarks.\n`,
	);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`[smoke:judges] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	},
);
