#!/usr/bin/env -S pnpm exec tsx
/**
 * Mini-bench with ensemble judges — Slice v2 / R7 Phase A rewrite.
 *
 * Runs ONE fixture against the 4 active strategies, evaluates each
 * task-accuracy probe with the multi-judge ensemble, classifies each
 * probe by stress type (recap-only vs tail-trivial) so the result table
 * reports strategy quality only on recap-only probes.
 *
 * R7 vs R1-R5:
 *   - `anthropic-native` strategy REMOVED (was a `return undefined` sentinel)
 *   - Single shared `buildVisibleContext()` from `src/visible-context.ts`
 *     — no per-site divergence, no asymmetric truncation.
 *   - Probe stress classified before evaluation; tail-trivial probes are
 *     reported separately, not mixed into strategy quality.
 *   - No silent fallback when reactive-vercel pruneMessages returns
 *     undefined — recap stays "" and the strategy is judged on that.
 *
 * Usage:
 *   source /home/luke/alpha-adk/data-private/llm-keys/llm.env
 *   pnpm --filter @nextain/agent-benchmarks tsx scripts/mini-bench-judge.ts <fixtureId>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";
import {
	createPiLLMMessagePrepareCompact,
	createHermesLLMMessagePrepareCompact,
} from "@nextain/agent-runtime";

import type { Fixture, FixtureProbe, StrategyId } from "../src/fixture.js";
import { classifyProbeStress, validateFixture } from "../src/fixture.js";
import { runFixture, createBenchSummarizer } from "../src/runner.js";
import { buildVisibleContext } from "../src/visible-context.js";
import { createBenchLLMClient } from "../src/bench-llm-client.js";
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
	// R8: head-to-head LLM compaction lineup.
	"pi",
	"hermes",
	"reactive",
	"naia+llm",
	"off",
];

// R7 Phase A: shared benchmark config — no longer hardcoded at each call site.
const BENCH_CONFIG = {
	keepTail: 10,
	contextWindowChars: 16_000,
	targetTokens: 1000,
} as const;

interface ProbeResult {
	readonly probe: FixtureProbe;
	readonly stress: "recap-only" | "tail-trivial" | "no-compaction" | "unclassified";
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
		readonly compactionLatencyMs: number;
		readonly compactionInputTokens: number;
		readonly compactionOutputTokens: number;
	};
	readonly vercelNoOp: boolean;
	readonly recapNoOp: boolean;
}

async function main(): Promise<number> {
	const fixtureId = process.argv[2] ?? "F001-customer-support";
	const fixturePath = join(FIXTURES_DIR, `${fixtureId}.fixture.json`);

	process.stderr.write(`[mini-bench] loading fixture ${fixtureId}...\n`);
	const raw = await readFile(fixturePath, "utf-8");
	const fixture = validateFixture(JSON.parse(raw));

	const taskProbes = fixture.probes.filter(
		(p): p is FixtureProbe & { type: "task-accuracy"; question: string } =>
			p.type === "task-accuracy",
	);
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

		// naia+llm needs a summarizer-injected MemorySystem.
		let summarizerClient: ReturnType<typeof createBenchLLMClient> | undefined;
		const memoryOpts: ConstructorParameters<typeof MemorySystem>[0] = {
			adapter: new LocalAdapter(memPath),
			consolidationIntervalMs: 0,
		};
		if (strategy === "naia+llm") {
			summarizerClient = createBenchLLMClient();
			memoryOpts.summarizer = createBenchSummarizer(summarizerClient);
		}
		const memorySystem = new MemorySystem(memoryOpts);
		try {
			// R8: lazy LLM client + factory per fixture run so anchored-iterative
			// summaries are scoped to the fixture and not leaked across strategies.
			const llmFor = (kind: "pi" | "hermes" | null) => {
				if (kind === null) return { prepare: undefined, client: undefined };
				const llm = createBenchLLMClient();
				const prepare = kind === "pi"
					? createPiLLMMessagePrepareCompact({ llm, keepRecentTokens: 100 })
					: createHermesLLMMessagePrepareCompact({
							llm,
							protectFirstN: 2,
							tailTokenBudget: 100,
						});
				return { prepare, client: llm };
			};
			const llmInfo = strategy === "pi" ? llmFor("pi")
				: strategy === "hermes" ? llmFor("hermes")
				: strategy === "naia+llm" ? { prepare: undefined, client: summarizerClient }
				: { prepare: undefined, client: undefined };
			const fr = await runFixture(fixture, strategy, {
				keepTail: BENCH_CONFIG.keepTail,
				targetTokens: BENCH_CONFIG.targetTokens,
				memorySystem,
				benchClient: llmInfo.client,
				...(llmInfo.prepare && strategy === "pi" ? { piPrepare: llmInfo.prepare } : {}),
				...(llmInfo.prepare && strategy === "hermes" ? { hermesPrepare: llmInfo.prepare } : {}),
			});

			const probeResults: ProbeResult[] = [];
			for (const probe of taskProbes) {
				const compactionPoints = fixture.compactionPoints ?? [];
				const lastCompactionPoint = [...compactionPoints]
					.filter((p) => p <= probe.afterTurn)
					.sort((a, b) => a - b)
					.pop();
				const stress = classifyProbeStress(
					probe.factTurns,
					lastCompactionPoint,
					BENCH_CONFIG.keepTail,
				);

				const ctx = buildVisibleContext({
					fixture,
					strategy,
					currentTurn: probe.afterTurn,
					recapContent: fr.recapContent ?? "",
					keepTail: BENCH_CONFIG.keepTail,
					contextWindowChars: BENCH_CONFIG.contextWindowChars,
				});

				process.stderr.write(
					`  probe@turn=${probe.afterTurn} [${stress}] → asking 4 judges...\n`,
				);
				const verdict = await runEnsemble(
					{ judges: defaultEnsemble },
					{
						question: probe.question,
						response: ctx.visible.slice(0, 6000),
						criterion: probe.criterion,
						timeoutMs: 90_000,
					},
				);
				probeResults.push({
					probe,
					stress,
					visibleSnippet: ctx.visible.slice(0, 240),
					ensemble: verdict,
				});
				const passN = Object.values(verdict.perJudge).filter(
					(r) => !isInfraError(r) && r.pass,
				).length;
				process.stderr.write(
					`    → ${passN}/${verdict.validCount} pass (infra=${verdict.infraErrorCount}, ensemble=${verdict.pass ? "PASS" : "FAIL"})\n`,
				);
			}

			// R7 Phase A: detect Vercel no-op (recap empty for reactive-vercel).
			// R7 Final-Audit MAJOR #8 extension: ALSO detect reactive/realtime
			// no-op (Korean naia-memory deterministic recap is fact-empty).
			// Any compacting strategy with empty recap is a no-op artefact —
			// reported uniformly via `recapNoOp` flag.
			const isCompactStrategy =
				strategy === "reactive" ||
				strategy === "reactive-vercel" ||
				strategy === "realtime" ||
				strategy === "pi" ||
				strategy === "hermes" ||
				strategy === "naia+llm";
			const recapNoOp =
				isCompactStrategy && (fr.recapContent ?? "").length === 0;

			results.push({
				strategy,
				probeResults,
				fixtureResult: {
					taskAccuracy: fr.taskAccuracy,
					factRecall: fr.factRecall,
					driftScore: fr.driftScore,
					totalTokens: fr.totalTokens,
					compactionLatencyMs: fr.compactionLatencyMs,
					compactionInputTokens: fr.compactionInputTokens,
					compactionOutputTokens: fr.compactionOutputTokens,
				},
				vercelNoOp:
					strategy === "reactive-vercel" && (fr.recapContent ?? "").length === 0,
				recapNoOp,
			});
		} finally {
			await memorySystem.close();
		}
	}

	// ── Render markdown report ─────────────────────────────────────────
	const lines: string[] = [];
	lines.push(`# Mini-bench (R7 / judge ensemble) — ${fixtureId} — ${date}`);
	lines.push("");
	lines.push(`- **Fixture**: ${fixtureId} (${fixture.domain})`);
	lines.push(`- **Strategies**: ${STRATEGIES.join(", ")}`);
	lines.push(`- **Probes**: ${taskProbes.length} task-accuracy`);
	lines.push(`- **Judges**: defaultEnsemble (GLM HTTP + opencode + codex + gemini CLI)`);
	lines.push(`- **Config**: keepTail=${BENCH_CONFIG.keepTail}, contextCap=${BENCH_CONFIG.contextWindowChars} chars, targetTokens=${BENCH_CONFIG.targetTokens}`);
	lines.push("");

	// Stress classification summary
	const probeStressCounts = {
		"recap-only": 0,
		"tail-trivial": 0,
		"no-compaction": 0,
		"unclassified": 0,
	};
	for (const r of results[0]?.probeResults ?? []) {
		probeStressCounts[r.stress]++;
	}
	lines.push(`## Probe stress classification`);
	lines.push("");
	lines.push(`| Stress class | Count | Meaning |`);
	lines.push(`|---|---:|---|`);
	lines.push(`| recap-only | ${probeStressCounts["recap-only"]} | Strategy MUST preserve the fact through compaction — genuine strategy-quality probe |`);
	lines.push(`| tail-trivial | ${probeStressCounts["tail-trivial"]} | Fact lives in preserved tail — answerable without compaction effort |`);
	lines.push(`| no-compaction | ${probeStressCounts["no-compaction"]} | No compactionPoint reached — measures context-cap only |`);
	lines.push(`| unclassified | ${probeStressCounts["unclassified"]} | Probe lacks \`factTurns\` — cannot determine stress |`);
	lines.push("");

	lines.push("## Ensemble verdict per strategy");
	lines.push("");
	lines.push(
		"| Strategy | recap-only | tail-trivial | unclassified | Recap no-op? | Avg validCount/4 | Compact ms | Compact tokens (in/out) |",
	);
	lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const r of results) {
		const recapOnlyProbes = r.probeResults.filter((pr) => pr.stress === "recap-only");
		const tailTrivialProbes = r.probeResults.filter((pr) => pr.stress === "tail-trivial");
		const unclassProbes = r.probeResults.filter((pr) => pr.stress === "unclassified");
		const rate = (probes: typeof recapOnlyProbes): string => {
			if (probes.length === 0) return "n/a";
			const pass = probes.filter((pr) => pr.ensemble.pass).length;
			return `${(pass / probes.length).toFixed(3)} (n=${probes.length})`;
		};
		const avgValid = r.probeResults.length === 0
			? 0
			: r.probeResults.reduce((acc, pr) => acc + pr.ensemble.validCount, 0) /
				r.probeResults.length;
		const noOpLabel = r.recapNoOp
			? r.vercelNoOp
				? "**YES (vercel)**"
				: "**YES (recap empty)**"
			: "no";
		const compactMs = r.fixtureResult.compactionLatencyMs.toFixed(0);
		const compactTokens = `${r.fixtureResult.compactionInputTokens}/${r.fixtureResult.compactionOutputTokens}`;
		lines.push(
			`| \`${r.strategy}\` | ${rate(recapOnlyProbes)} | ${rate(tailTrivialProbes)} | ${rate(unclassProbes)} | ${noOpLabel} | ${avgValid.toFixed(1)} | ${compactMs} | ${compactTokens} |`,
		);
	}
	lines.push("");
	lines.push("Strategy quality is reported per stress class. recap-only = real compaction stress; tail-trivial = answerable from preserved tail; unclassified = abstention or factTurns omitted.");
	lines.push("");

	// Per-judge breakdown
	lines.push("## Per-judge breakdown");
	lines.push("");
	for (const r of results) {
		lines.push(`### \`${r.strategy}\`${r.vercelNoOp ? " (Vercel no-op — recap empty)" : ""}`);
		lines.push("");
		for (let i = 0; i < r.probeResults.length; i++) {
			const pr = r.probeResults[i]!;
			lines.push(`**Probe ${i + 1}** [${pr.stress}] (after turn ${pr.probe.afterTurn}) — ensemble: ${pr.ensemble.pass ? "✅ PASS" : "❌ FAIL"} (${pr.ensemble.validCount}/4 valid)`);
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

	lines.push("## Caveats (R7)");
	lines.push("");
	lines.push("- Single fixture; not statistically conclusive.");
	lines.push("- `anthropic-native` strategy removed — was a `return undefined` sentinel in R1-R5.");
	lines.push("- Strategy quality reported on **recap-only** probes only. tail-trivial probes are reported in a separate column but do NOT reflect compaction effectiveness.");
	lines.push("- `reactive-vercel` Vercel no-op (`recap empty`) is flagged explicitly — those cells do not represent the Vercel cookbook recipe in action.");

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
