/**
 * Benchmark report — Stage 1b. Pure markdown formatter over the runner's
 * results. Mirrors the pre-rewrite monorepo report (`packages/benchmarks/src/
 * report.ts`) but takes the Stage-1b `FixtureResult[]` shape (per-fixture
 * pass/scores) instead of the strategy-grouped shape.
 *
 * Pure: same results → byte-identical string. No console / process I/O
 * (repo rule F-LOG-3) — `formatReport` RETURNS the markdown.
 */

import type { FixtureResult } from "./runner.js";

function fmt(n: number, digits = 3): string {
	if (Number.isNaN(n) || !Number.isFinite(n)) return "—";
	return n.toFixed(digits);
}

/**
 * Render runner results as a markdown summary: a header with the aggregate
 * pass count, a per-fixture table (pass + the three score axes + error count),
 * and a details section listing any per-probe notes for failing fixtures.
 */
export function formatReport(results: readonly FixtureResult[]): string {
	const total = results.length;
	const passed = results.filter((r) => r.pass).length;
	const lines: string[] = [];

	lines.push("# Benchmark Report");
	lines.push("");
	lines.push(`- **Fixtures**: ${total}`);
	lines.push(`- **Passed**: ${passed}/${total}`);
	lines.push(`- **Failed**: ${total - passed}/${total}`);
	lines.push("");

	lines.push("## Per-fixture");
	lines.push("");
	lines.push("| Fixture | Result | Fact-recall | Task-accuracy | Drift | Errors |");
	lines.push("|---|:---:|---:|---:|---:|---:|");
	for (const r of results) {
		const mark = r.pass ? "PASS" : "FAIL";
		const errCount = r.errors.length === 0 ? "—" : `${r.errors.length}`;
		lines.push(
			`| \`${r.fixtureId}\` | ${mark} | ${fmt(r.scores.factRecall)} | ${fmt(r.scores.taskAccuracy)} | ${fmt(r.scores.driftScore)} | ${errCount} |`,
		);
	}
	lines.push("");

	// Details only for failing fixtures — passing runs stay quiet.
	const failing = results.filter((r) => !r.pass);
	if (failing.length > 0) {
		lines.push("## Failures");
		lines.push("");
		for (const r of failing) {
			lines.push(`### \`${r.fixtureId}\``);
			lines.push("");
			for (const d of r.details) {
				if (!d.pass) {
					lines.push(`- probe ${d.probeIndex} (${d.type}): ${d.note}`);
				}
			}
			for (const e of r.errors) {
				lines.push(`- error: ${e}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}
