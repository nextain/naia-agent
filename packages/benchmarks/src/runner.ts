/**
 * Benchmark runner — Slice 3-XR-Compact P6.
 *
 * Drives each fixture through MemorySystem.compact() with each strategy,
 * evaluates probes deterministically (keyword match + Jaccard for drift),
 * and emits a markdown report. The judge profile is intentionally
 * "deterministic-only" — LLM-as-judge ensemble integration (NAIA_JUDGE_ENSEMBLE)
 * is the next iteration, gated on API keys available in the host
 * environment.
 *
 * Why deterministic-first: even without an LLM judge, the keyword + drift
 * metrics already discriminate the three strategies meaningfully:
 *   - off: tail-only context (no recap) — fact-recall drops on facts
 *     established in the head.
 *   - reactive: head is replaced by a 5-section markdown recap. Keywords
 *     in Goal / Tool calls / Files sections survive.
 *   - realtime: same recap shape, but seeded from the rolling summary that
 *     accumulated during encode(). Per-turn cost is paid up front.
 *   - anthropic-native: short-circuited host-side → behavior matches `off`
 *     under this harness (the actual benefit would only show through a real
 *     Anthropic Messages API call, which is out of scope here).
 *
 * Usage:
 *   pnpm --filter @nextain/agent-benchmarks bench:compact
 *   pnpm --filter @nextain/agent-benchmarks bench:compact -- --strategies reactive,realtime
 *   pnpm --filter @nextain/agent-benchmarks bench:compact -- --fixtures F001-customer-support
 */

import { performance } from "node:perf_hooks";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";

import type {
	Fixture,
	FixtureProbe,
	FixtureResult,
	FixtureTurn,
	StrategyId,
} from "./fixture.js";
import { validateFixture } from "./fixture.js";
import { driftScore } from "./metrics.js";
import { renderReport } from "./report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const REPORTS_DIR = join(HERE, "..", "reports");

const DEFAULT_STRATEGIES: readonly StrategyId[] = [
	"reactive",
	"realtime",
	"anthropic-native",
	"off",
];

interface CliOptions {
	readonly strategies: readonly StrategyId[];
	readonly fixtureGlob: readonly string[] | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
	let strategies: readonly StrategyId[] = DEFAULT_STRATEGIES;
	let fixtureGlob: readonly string[] | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--strategies" && i + 1 < argv.length) {
			const next = argv[i + 1]!;
			strategies = next
				.split(",")
				.map((s) => s.trim())
				.filter((s): s is StrategyId =>
					s === "reactive" || s === "realtime" || s === "anthropic-native" || s === "off",
				);
			i++;
		} else if (a === "--fixtures" && i + 1 < argv.length) {
			fixtureGlob = argv[i + 1]!.split(",").map((s) => s.trim());
			i++;
		}
	}
	return { strategies, fixtureGlob };
}

export async function loadFixtures(globIds: readonly string[] | null): Promise<Fixture[]> {
	let files: string[];
	try {
		files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".fixture.json"));
	} catch {
		return [];
	}
	const out: Fixture[] = [];
	for (const f of files) {
		const raw = await readFile(join(FIXTURES_DIR, f), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const fixture = validateFixture(parsed);
		if (globIds === null || globIds.includes(fixture.id)) {
			out.push(fixture);
		}
	}
	return out;
}

/**
 * Placeholder runner — used by P1 unit tests and as a fallback in CI when
 * MemorySystem cannot be initialized (e.g. better-sqlite3 native module
 * unavailable). Real measurement goes through `runFixture` below.
 */
export function runFixturePlaceholder(
	fixture: Fixture,
	strategy: StrategyId,
): FixtureResult {
	return {
		fixtureId: fixture.id,
		strategy,
		taskAccuracy: 0,
		factRecall: 0,
		latencyP50Ms: 0,
		latencyP99Ms: 0,
		compactionLatencyMs: 0,
		totalTokens: 0,
		driftScore: 1,
		errors: [`placeholder — runFixture() bypassed (CI fallback)`],
	};
}

/**
 * Deterministic probe evaluator. No LLM-judge — keyword match for
 * fact-recall, "context is non-empty + carries the probe's domain keyword"
 * for task-accuracy. Cheap, reproducible, surfaces drift through the recap
 * shape itself.
 */
interface ProbeOutcome {
	probe: FixtureProbe;
	pass: boolean;
	visibleSnippet: string;
}

function evaluateProbe(
	probe: FixtureProbe,
	fixture: Fixture,
	currentTurn: number,
	recapContent: string,
	strategy: StrategyId,
	keepTail: number,
): ProbeOutcome {
	const compactionPoints = fixture.compactionPoints ?? [];
	const lastCompactionPoint = [...compactionPoints]
		.filter((p) => p <= currentTurn)
		.sort((a, b) => a - b)
		.pop();

	let visibleText: string;
	const tailStart =
		lastCompactionPoint !== undefined
			? Math.max(lastCompactionPoint, currentTurn - keepTail)
			: 0;

	const tailTurns = fixture.turns.slice(tailStart, currentTurn);
	const tailText = tailTurns.map((t) => t.content).join("\n");

	const wasCompacted =
		lastCompactionPoint !== undefined &&
		(strategy === "reactive" || strategy === "realtime");

	if (wasCompacted) {
		// After compaction: recap + tail.
		visibleText = `${recapContent}\n\n${tailText}`;
	} else {
		// off / anthropic-native (host-side disabled) / no compaction yet:
		// raw transcript up to currentTurn (the full LLM context until the
		// provider raises a context-length error, which we don't simulate).
		visibleText = fixture.turns
			.slice(0, currentTurn)
			.map((t) => t.content)
			.join("\n");
	}

	const lower = visibleText.toLowerCase();
	let pass: boolean;

	if (probe.type === "fact-recall") {
		// Every expected keyword must be present (case-insensitive). This is
		// strict: drop one identifier → fail. That's the point — strategy
		// quality is measured by what survives compaction.
		pass = probe.expectedKeywords.every((k) => lower.includes(k.toLowerCase()));
	} else if (probe.type === "task-accuracy") {
		// Without LLM judge, approximate by: context contains the fixture's
		// domain-anchor keyword and is non-trivial. This is intentionally
		// coarse — LLM-judge wiring is the next iteration.
		const domainAnchor = fixture.domain.split("-")[0]?.toLowerCase() ?? "";
		pass = visibleText.length > 200 && (domainAnchor === "" || lower.includes(domainAnchor));
	} else {
		// drift probe — scored separately via driftScore.
		pass = true;
	}

	return { probe, pass, visibleSnippet: visibleText.slice(0, 240) };
}

interface RunOptions {
	keepTail: number;
	targetTokens: number;
	memorySystem: MemorySystem;
}

export async function runFixture(
	fixture: Fixture,
	strategy: StrategyId,
	opts: RunOptions,
): Promise<FixtureResult> {
	const { keepTail, targetTokens, memorySystem } = opts;
	const sessionId = `${fixture.id}-${strategy}-${performance.now().toFixed(0)}`;
	const compactionPoints = (fixture.compactionPoints ?? []).slice().sort((a, b) => a - b);
	const probesByTurn = new Map<number, FixtureProbe[]>();
	for (const p of fixture.probes) {
		if (!probesByTurn.has(p.afterTurn)) probesByTurn.set(p.afterTurn, []);
		probesByTurn.get(p.afterTurn)!.push(p);
	}

	const perTurnLatencies: number[] = [];
	const compactionLatencies: number[] = [];
	const errors: string[] = [];

	let priorRecap: { role: "assistant"; content: string; timestamp?: number } | undefined;
	let recapContent = "";
	const outcomes: ProbeOutcome[] = [];

	for (let i = 0; i < fixture.turns.length; i++) {
		const turn = fixture.turns[i]!;
		const turnIdx = i + 1;
		const t0 = performance.now();

		// realtime: encode every turn so the rolling summary accumulates.
		// reactive/off/anthropic-native: skip encode here (encode is a
		// memory-system concern unrelated to compaction in those modes).
		if (strategy === "realtime") {
			try {
				await memorySystem.encode(
					{
						content: turn.content,
						role: mapRole(turn.role),
						timestamp: Date.now(),
					},
					{ sessionId },
				);
			} catch (err) {
				errors.push(`encode@${turnIdx}: ${String(err)}`);
			}
		}
		perTurnLatencies.push(performance.now() - t0);

		// Forced compaction trigger?
		if (
			compactionPoints.includes(turnIdx) &&
			(strategy === "reactive" || strategy === "realtime")
		) {
			const head: FixtureTurn[] = fixture.turns
				.slice(0, turnIdx)
				.map((t) => ({ role: t.role, content: t.content }));
			const cT0 = performance.now();
			try {
				const r = await memorySystem.compact({
					messages: head,
					keepTail,
					targetTokens,
					sessionId,
					strategy,
					...(priorRecap !== undefined ? { priorRecap } : {}),
				});
				compactionLatencies.push(performance.now() - cT0);
				recapContent = r.summary.content;
				priorRecap = {
					role: "assistant",
					content: recapContent,
					...(r.summary.timestamp !== undefined ? { timestamp: r.summary.timestamp } : {}),
				};
			} catch (err) {
				compactionLatencies.push(performance.now() - cT0);
				errors.push(`compact@${turnIdx}: ${String(err)}`);
			}
		}

		// Probes at this turn?
		const probes = probesByTurn.get(turnIdx);
		if (probes) {
			for (const p of probes) {
				outcomes.push(
					evaluateProbe(p, fixture, turnIdx, recapContent, strategy, keepTail),
				);
			}
		}
	}

	// Probes that ask after-the-end (afterTurn >= turns.length).
	for (const [turnNum, probes] of probesByTurn.entries()) {
		if (turnNum > fixture.turns.length) {
			for (const p of probes) {
				outcomes.push(
					evaluateProbe(
						p,
						fixture,
						fixture.turns.length,
						recapContent,
						strategy,
						keepTail,
					),
				);
			}
		}
	}

	// Drift: compact-path visible text vs no-compact full transcript.
	const fullTranscript = fixture.turns.map((t) => t.content).join("\n");
	const compactPath =
		recapContent.length > 0
			? `${recapContent}\n${fixture.turns.slice(-keepTail).map((t) => t.content).join("\n")}`
			: fullTranscript;
	const drift = driftScore(compactPath, fullTranscript);

	// Metric aggregates.
	const factRecallProbes = outcomes.filter((o) => o.probe.type === "fact-recall");
	const taskProbes = outcomes.filter((o) => o.probe.type === "task-accuracy");
	const taskAcc =
		taskProbes.length === 0
			? 0
			: taskProbes.filter((o) => o.pass).length / taskProbes.length;
	const factR =
		factRecallProbes.length === 0
			? 0
			: factRecallProbes.filter((o) => o.pass).length / factRecallProbes.length;

	const sortedTurnLat = [...perTurnLatencies].sort((a, b) => a - b);
	const p50 = sortedTurnLat[Math.floor(sortedTurnLat.length * 0.5)] ?? 0;
	const p99 = sortedTurnLat[Math.min(sortedTurnLat.length - 1, Math.floor(sortedTurnLat.length * 0.99))] ?? 0;
	const compactionAvg =
		compactionLatencies.length === 0
			? 0
			: compactionLatencies.reduce((a, b) => a + b, 0) / compactionLatencies.length;

	const totalChars =
		fixture.turns.reduce((acc, t) => acc + t.content.length, 0) + recapContent.length;
	const totalTokens = Math.floor(totalChars / 4);

	return {
		fixtureId: fixture.id,
		strategy,
		taskAccuracy: taskAcc,
		factRecall: factR,
		latencyP50Ms: p50,
		latencyP99Ms: p99,
		compactionLatencyMs: compactionAvg,
		totalTokens,
		driftScore: drift,
		errors,
	};
}

function mapRole(role: FixtureTurn["role"]): "user" | "assistant" | "tool" {
	if (role === "system") return "user"; // memory has no native "system" role
	return role;
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function main(argv: readonly string[]): Promise<void> {
	const opts = parseArgs(argv);
	const fixtures = await loadFixtures(opts.fixtureGlob);

	process.stderr.write(
		`[bench:compact] loaded ${fixtures.length} fixture(s), running ${opts.strategies.length} strategy(s)\n`,
	);

	// Per-strategy MemorySystem so rolling state is isolated.
	const date = new Date().toISOString().slice(0, 10);
	await ensureDir(REPORTS_DIR);

	const results: FixtureResult[] = [];
	for (const s of opts.strategies) {
		const memPath = join(REPORTS_DIR, `_mem-${date}-${s}.json`);
		const memorySystem = new MemorySystem({
			adapter: new LocalAdapter(memPath),
			consolidationIntervalMs: 0,
		});
		try {
			for (const fx of fixtures) {
				const r = await runFixture(fx, s, {
					keepTail: 2,
					targetTokens: 1000,
					memorySystem,
				});
				results.push(r);
				process.stderr.write(
					`[bench:compact] ${fx.id} × ${s} — task=${r.taskAccuracy.toFixed(2)} recall=${r.factRecall.toFixed(2)} drift=${r.driftScore.toFixed(2)}\n`,
				);
			}
		} finally {
			await memorySystem.close();
		}
	}

	const report = renderReport({
		date,
		fixtureCount: fixtures.length,
		strategiesUnderTest: opts.strategies,
		results,
		judgeProfile: "none",
		notes:
			"Deterministic measurement — keyword match for fact-recall + Jaccard for drift. LLM-as-judge ensemble (NAIA_JUDGE_ENSEMBLE) is the next iteration, gated on API keys.",
	});

	const reportPath = join(REPORTS_DIR, `${date}-deterministic.md`);
	await writeFile(reportPath, report, "utf-8");
	process.stderr.write(`[bench:compact] report → ${reportPath}\n`);
	process.stdout.write(report);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[bench:compact] FATAL: ${msg}\n`);
		process.exit(1);
	});
}
