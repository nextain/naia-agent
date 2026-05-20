/**
 * Benchmark runner — Slice 3-XR-Compact P1 skeleton.
 *
 * P1 ships a runnable but inert harness: it loads fixtures, iterates the
 * configured strategies, and emits a report with placeholder metrics. The
 * actual compaction wire-up (driving naia-agent through each fixture, calling
 * the strategy's `compact()`, observing latency/cost) lands in P6.
 *
 * Why ship inert P1: end-to-end smoke (file → schema → report) catches
 * monorepo wiring bugs (tsconfig refs, vitest discovery, package exports)
 * BEFORE we're staring at LLM-judge flakes. Same pattern as Slice 3-XR-G's
 * scenario harness.
 *
 * Usage:
 *   pnpm --filter @nextain/agent-benchmarks bench:compact
 *   pnpm --filter @nextain/agent-benchmarks bench:compact -- --strategies reactive,realtime
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Fixture, FixtureResult, StrategyId } from "./fixture.js";
import { validateFixture } from "./fixture.js";
import { renderReport } from "./report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");
const REPORTS_DIR = join(HERE, "..", "reports");

const DEFAULT_STRATEGIES: readonly StrategyId[] = ["reactive", "realtime", "off"];

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
 * P1 placeholder runner. Returns a deterministic stub FixtureResult so the
 * full toolchain (load → run → render → write) is exercised end-to-end.
 * P6 replaces with real strategy execution against naia-agent.
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
		errors: [`P1 stub — strategy ${strategy} not yet wired (lands in P3/P4/P5)`],
	};
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

	const results: FixtureResult[] = [];
	for (const fx of fixtures) {
		for (const s of opts.strategies) {
			results.push(runFixturePlaceholder(fx, s));
		}
	}

	const date = new Date().toISOString().slice(0, 10);
	const report = renderReport({
		date,
		fixtureCount: fixtures.length,
		strategiesUnderTest: opts.strategies,
		results,
		judgeProfile: "none",
		notes:
			"P1 skeleton — placeholder metrics. Real strategy execution + LLM-judge wiring lands in P3/P4/P5/P6.",
	});

	await ensureDir(REPORTS_DIR);
	const reportPath = join(REPORTS_DIR, `${date}-skeleton.md`);
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
