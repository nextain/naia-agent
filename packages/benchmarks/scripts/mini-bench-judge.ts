#!/usr/bin/env -S pnpm exec tsx
/**
 * Mini-bench with ensemble judges — Slice 3-XR-Compact #48 PoC measurement.
 *
 * Runs ONE fixture against ALL 4 strategies, then evaluates each task-accuracy
 * probe with the 4-judge ensemble (GLM HTTP + opencode + codex + gemini CLI).
 * Outputs per-strategy ensemble verdict + per-judge breakdown — the first
 * objective performance measurement the user asked for.
 *
 * Scope: 1 fixture × 4 strategies × N probes × 4 judges = ~16 LLM calls.
 * Cost-controlled minimal sample. Full 10-fixture × 4-strategy × 4-judge run
 * is the next-session work.
 *
 * Usage:
 *   source /home/luke/alpha-adk/data-private/llm-keys/llm.env
 *   pnpm --filter @nextain/agent-benchmarks tsx scripts/mini-bench-judge.ts
 *
 *   # or with a specific fixture
 *   pnpm --filter @nextain/agent-benchmarks tsx scripts/mini-bench-judge.ts F001-customer-support
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

import type { Fixture, FixtureProbe, StrategyId } from "../src/fixture.js";
import { validateFixture } from "../src/fixture.js";
import { runFixture } from "../src/runner.js";
import {
	defaultEnsemble,
	isInfraError,
	runEnsemble,
} from "../src/judges/index.js";
import type { EnsembleVerdict } from "../src/judges/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "src", "fixtures");
const REPORTS_DIR = join(HERE, "..", "reports");

const STRATEGIES: readonly StrategyId[] = [
	"reactive",
	"reactive-vercel",
	"realtime",
	"anthropic-native",
	"off",
];

interface ProbeResult {
	readonly probe: FixtureProbe;
	readonly visibleSnippet: string;
	readonly ensemble: EnsembleVerdict;
}

interface StrategyResult {
	readonly strategy: StrategyId;
	readonly probeResults: readonly ProbeResult[];
	readonly fixtureResult: {
		readonly taskAccuracy: number;
		readonly factRecall: number;
		readonly driftScore: number;
		readonly totalTokens: number;
	};
}

/**
 * Reconstruct the visible context the LLM would see at a probe turn.
 *
 * Phase 1.3 (#56) R2 fix (adversarial review S1): the previous heuristic
 * sliced fixture turns and showed the **same** sliced text to judges
 * regardless of compaction strategy. That made `reactive` (5-section
 * markdown recap) and `reactive-vercel` (Vercel pruneMessages output)
 * look identical to the judges — an unfair comparison.
 *
 * Now: when the strategy actually compacted (`reactive` / `reactive-vercel`
 * / `realtime` with a compactionPoint <= currentTurn), we prepend the
 * real `recapContent` produced by `runner.runFixture()`. The tail still
 * comes from the fixture (this is what the agent would still have in
 * `#history` after compaction).
 *
 * For `off` / `anthropic-native` / no-op vercel prune: recap is empty, so
 * we show the full transcript up to the probe turn (matches what the LLM
 * would actually have to read).
 */
/**
 * Phase 1.3 R5 (codex S19 fix): simulate the LLM provider's context window
 * truncation with a turn-boundary search that respects ROLE-PREFIXED line
 * starts (`user: ...`, `assistant: ...`, `tool: ...`), not just any newline.
 * R3's heuristic could land mid-message because turns themselves carry
 * newlines (e.g. assistant content with multiple paragraphs).
 *
 * Heuristic: cap visible window to `windowChars`, search forward for the
 * next role-prefixed line start, fall back to nearest newline.
 */
function simulateContextWindow(text: string, windowChars: number): string {
	if (text.length <= windowChars) return text;
	const tailStart = text.length - windowChars;
	// Look for a role-prefixed line ("user:", "assistant:", "tool:") which
	// is the start of a turn boundary. Falls back to nearest newline.
	const rolePrefixRe = /\n(user:|assistant:|tool:|system:)/g;
	rolePrefixRe.lastIndex = tailStart;
	const match = rolePrefixRe.exec(text);
	let start: number;
	if (match) {
		start = match.index + 1; // skip the leading \n
	} else {
		const nlAfter = text.indexOf("\n", tailStart);
		start = nlAfter !== -1 ? nlAfter + 1 : tailStart;
	}
	return `[context truncated by provider — ${(text.length - start)} of ${text.length} chars retained]\n${text.slice(start)}`;
}

function extractVisibleContext(
	fixture: Fixture,
	strategy: StrategyId,
	currentTurn: number,
	recapContent: string,
	keepTail: number,
): string {
	const compactionPoints = fixture.compactionPoints ?? [];
	const last = [...compactionPoints]
		.filter((p) => p <= currentTurn)
		.sort((a, b) => a - b)
		.pop();
	const isCompactStrategy =
		strategy === "reactive" ||
		strategy === "reactive-vercel" ||
		strategy === "realtime";

	// Phase 1.3 R4 (gemini S12 fix — "Missing Middle"): tail starts at
	// `lastCompactionPoint - keepTail`, not `lastCompactionPoint`. The
	// summarizer keeps the last `keepTail` turns BEFORE the compaction
	// point verbatim (they're outside the recap by construction). Tail
	// then also covers `[lastCompactionPoint .. currentTurn]` (the
	// post-compaction NEW turns).
	//
	// Visible window = recap (turns [0 .. last - keepTail]) + tail
	// (turns [last - keepTail .. currentTurn]).
	//
	// R3 used `slice(last, currentTurn)`, dropping the `keepTail`
	// protected window from the judge's view.
	if (isCompactStrategy && last !== undefined && recapContent.length > 0) {
		const tailStart = Math.max(0, last - keepTail);
		const tail = fixture.turns
			.slice(tailStart, currentTurn)
			.map((t) => `${t.role}: ${t.content}`)
			.join("\n");
		const header =
			strategy === "reactive-vercel"
				? "[reactive-vercel post-prune window]"
				: `[after compaction at turn ${last}]`;
		return `${header}\n${recapContent}\n\n${tail}`;
	}
	// No effective compaction OR no-op vercel prune: full transcript.
	// (Caller applies `simulateContextWindow` to truncate.)
	return fixture.turns
		.slice(0, currentTurn)
		.map((t) => `${t.role}: ${t.content}`)
		.join("\n");
}

async function main(): Promise<number> {
	const fixtureId = process.argv[2] ?? "F001-customer-support";
	const fixturePath = join(FIXTURES_DIR, `${fixtureId}.fixture.json`);

	process.stderr.write(`[mini-bench] loading fixture ${fixtureId}...\n`);
	const raw = await readFile(fixturePath, "utf-8");
	const fixture = validateFixture(JSON.parse(raw));

	const taskProbes = fixture.probes.filter((p) => p.type === "task-accuracy");
	if (taskProbes.length === 0) {
		process.stderr.write(
			`[mini-bench] fixture has no task-accuracy probes — nothing to judge.\n`,
		);
		return 1;
	}
	process.stderr.write(
		`[mini-bench] ${taskProbes.length} task-accuracy probe(s) × ${STRATEGIES.length} strategies × 4 judges = up to ${taskProbes.length * STRATEGIES.length * 4} LLM calls\n\n`,
	);

	const date = new Date().toISOString().slice(0, 10);
	await mkdir(REPORTS_DIR, { recursive: true });

	const results: StrategyResult[] = [];
	for (const strategy of STRATEGIES) {
		process.stderr.write(`[mini-bench] strategy=${strategy}\n`);
		const memPath = join(REPORTS_DIR, `_mem-judge-${date}-${strategy}.json`);
		const memorySystem = new MemorySystem({
			adapter: new LocalAdapter(memPath),
			consolidationIntervalMs: 0,
		});
		try {
			const fr = await runFixture(fixture, strategy, {
				keepTail: 2,
				targetTokens: 1000,
				memorySystem,
			});

			const probeResults: ProbeResult[] = [];
			for (const probe of taskProbes) {
				const recap = fr.recapContent ?? "";
				let visible = extractVisibleContext(
					fixture,
					strategy,
					probe.afterTurn,
					recap,
					2, // S12 fix: keepTail matches runner.ts default
				);
				// Phase 1.3 R5 (codex S18 fairness inversion fix): apply the
				// 1200-char cap to the **tail portion only**. The recap is by
				// design the compressed product the agent worked hard to
				// produce — truncating it from the right would destroy the
				// compaction itself (R4's uniform cap could throw the entire
				// recap away when recap+tail > cap, keeping only the latest
				// tail). Instead, preserve the recap and trim the tail to fit.
				//
				// Strategies without compaction (off / anthropic-native /
				// vercel-no-op) get their full-transcript visible context
				// truncated as before — there's no recap to preserve.
				const CONTEXT_WINDOW_CHARS = 1200;
				const isCompactStrategy =
					strategy === "reactive" ||
					strategy === "reactive-vercel" ||
					strategy === "realtime";
				if (isCompactStrategy && recap.length > 0) {
					// Allocate cap budget: recap kept whole, tail truncated.
					const tailBudget = Math.max(0, CONTEXT_WINDOW_CHARS - recap.length);
					if (tailBudget < visible.length - recap.length) {
						// Find tail portion (after recap + separator).
						const recapEndIdx = visible.indexOf(recap) + recap.length;
						const tailPortion = visible.slice(recapEndIdx);
						const truncatedTail = simulateContextWindow(
							tailPortion,
							tailBudget,
						);
						visible = visible.slice(0, recapEndIdx) + truncatedTail;
					}
				} else {
					visible = simulateContextWindow(visible, CONTEXT_WINDOW_CHARS);
				}
				// Phase 1.3 R2 (codex S8 fix): prefer the fixture-author's
				// explicit `question`. Fall back to the last user turn ONLY
				// for legacy fixtures that pre-date the schema change. The
				// fallback is structurally wrong (judge evaluates a different
				// prompt) — emit a stderr warning so reviewers notice.
				const explicitQuestion =
					probe.type === "task-accuracy" ? probe.question : undefined;
				const fallbackQuestion =
					fixture.turns
						.slice(0, probe.afterTurn)
						.filter((t) => t.role === "user")
						.pop()?.content ?? "(unknown)";
				if (!explicitQuestion) {
					process.stderr.write(
						`  ⚠ S8 fallback: ${fixture.id} probe@${probe.afterTurn} lacks explicit \`question\` — using last user turn (may not match fixture intent)\n`,
					);
				}
				const lastUserTurn = explicitQuestion ?? fallbackQuestion;
				process.stderr.write(
					`  probe@turn=${probe.afterTurn} → asking 4 judges...\n`,
				);
				const verdict = await runEnsemble(
					{ judges: defaultEnsemble },
					{
						question: lastUserTurn,
						response: visible.slice(0, 6000),
						criterion: probe.criterion,
						timeoutMs: 90_000,
					},
				);
				probeResults.push({
					probe,
					visibleSnippet: visible.slice(0, 240),
					ensemble: verdict,
				});
				const passN = Object.values(verdict.perJudge).filter(
					(r) => !isInfraError(r) && r.pass,
				).length;
				process.stderr.write(
					`    → ${passN}/${verdict.validCount} pass (infra=${verdict.infraErrorCount}, ensemble=${verdict.pass ? "PASS" : "FAIL"})\n`,
				);
			}
			results.push({
				strategy,
				probeResults,
				fixtureResult: {
					taskAccuracy: fr.taskAccuracy,
					factRecall: fr.factRecall,
					driftScore: fr.driftScore,
					totalTokens: fr.totalTokens,
				},
			});
		} finally {
			await memorySystem.close();
		}
	}

	// Render markdown report
	const lines: string[] = [];
	lines.push(`# Mini-bench (judge ensemble) — ${fixtureId} — ${date}`);
	lines.push("");
	lines.push(`- **Fixture**: ${fixtureId} (${fixture.domain})`);
	lines.push(`- **Strategies**: ${STRATEGIES.join(", ")}`);
	lines.push(`- **Probes**: ${taskProbes.length} task-accuracy`);
	lines.push(
		`- **Judges**: defaultEnsemble (GLM HTTP + opencode CLI + codex CLI + gemini CLI)`,
	);
	lines.push("");
	lines.push("## Ensemble verdict per strategy (majority of valid judges)");
	lines.push("");
	lines.push(
		"| Strategy | Ensemble PASS rate | Avg validCount/4 | Infra errors | Anchor-heuristic | Keyword-recall |",
	);
	lines.push("|---|---:|---:|---:|---:|---:|");
	// Phase 1.3 R2 (codex S5 fix): the last two columns are NOT "deterministic
	// task accuracy" — that label confused readers. They are:
	//  - Anchor-heuristic: `evaluateProbe()` heuristic (visible len > 200 AND
	//    domain anchor present). Coarse; for sanity, not for ranking.
	//  - Keyword-recall: every probe-expected keyword present in visible text.
	//    The honest deterministic signal.
	for (const r of results) {
		const passCount = r.probeResults.filter((pr) => pr.ensemble.pass).length;
		const passRate = r.probeResults.length === 0 ? 0 : passCount / r.probeResults.length;
		const avgValid = r.probeResults.length === 0
			? 0
			: r.probeResults.reduce((acc, pr) => acc + pr.ensemble.validCount, 0) /
				r.probeResults.length;
		const infraSum = r.probeResults.reduce(
			(acc, pr) => acc + pr.ensemble.infraErrorCount,
			0,
		);
		lines.push(
			`| \`${r.strategy}\` | ${passRate.toFixed(3)} | ${avgValid.toFixed(1)} | ${infraSum} | ${r.fixtureResult.taskAccuracy.toFixed(3)} | ${r.fixtureResult.factRecall.toFixed(3)} |`,
		);
	}
	lines.push("");
	lines.push("## Per-judge breakdown");
	lines.push("");
	for (const r of results) {
		lines.push(`### \`${r.strategy}\``);
		lines.push("");
		for (let i = 0; i < r.probeResults.length; i++) {
			const pr = r.probeResults[i]!;
			lines.push(`**Probe ${i + 1}** (after turn ${pr.probe.afterTurn}) — ensemble: ${pr.ensemble.pass ? "✅ PASS" : "❌ FAIL"} (${pr.ensemble.validCount}/4 valid)`);
			lines.push("");
			for (const [name, result] of Object.entries(pr.ensemble.perJudge)) {
				if (isInfraError(result)) {
					lines.push(
						`- \`${name}\` — **INFRA** (${result.latencyMs.toFixed(0)}ms): ${result.infraError.slice(0, 160)}`,
					);
				} else {
					lines.push(
						`- \`${name}\` — ${result.pass ? "PASS" : "FAIL"} (${result.latencyMs.toFixed(0)}ms): ${result.reason.slice(0, 200)}`,
					);
				}
			}
			lines.push("");
		}
	}
	lines.push("## Caveats");
	lines.push("");
	lines.push("- Single fixture; not statistically conclusive.");
	lines.push("- `extractVisibleContext()` here is a heuristic — the production wire-in is `runner.ts`'s `evaluateProbe` which uses the actual recap content. Refining is part of the full follow-up.");
	lines.push("- GLM HTTP endpoint timeout was observed in this session — the ensemble still ran with 3/4 judges.");
	lines.push("- This is the FIRST ensemble-based reading of strategy quality. Treat values as directional, not absolute.");
	lines.push("");

	const reportPath = join(REPORTS_DIR, `${date}-mini-bench-judge-${fixtureId}.md`);
	await writeFile(reportPath, lines.join("\n"), "utf-8");
	process.stderr.write(`\n[mini-bench] report → ${reportPath}\n`);
	process.stdout.write(lines.join("\n"));
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`[mini-bench] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	},
);
