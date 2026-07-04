/**
 * Human-like memory bench — fixture record / replay + report (Slice HL-4).
 *
 * A live run (real Gemini) is non-deterministic and needs credentials, so it
 * cannot gate CI. This module lets a live run RECORD each probe's deterministic
 * observation + trace + bucket to a JSON fixture; REPLAY then re-runs the pure
 * scoring pipeline (isDegenerateResponse + classifyPipeline) over the recorded
 * data with NO model and NO key. The committed fixture thus pins the scoring
 * behavior on REAL recorded responses — a regression fails if the classifier or
 * the degenerate-guard drifts (G15: CI fixture-only, real-LLM opt-in).
 *
 * Judge (social-quality) scores are non-deterministic and credit-gated, so they
 * are NOT part of the deterministic fixture; judge aggregation is unit-tested
 * separately (judge.test.ts).
 */
import type { PipelineBucket, PipelineOutcome, PipelineTrace, ProbeFamily, ProbePolarity } from "./types.js";
import { classifyPipeline } from "./pipeline.js";
import { isDegenerateResponse } from "./observe.js";

export const HUMANLIKE_FIXTURE_VERSION = 1 as const;

/** The deterministic booleans a live run observed (koIncludes-resolved). */
export type RecordedTrace = Omit<PipelineTrace, "probeId" | "responseText">;

export interface RecordedProbe {
	readonly scenarioId: string;
	readonly probeId: string;
	readonly family: ProbeFamily;
	readonly polarity: ProbePolarity;
	readonly observation: {
		readonly markerEmitted: boolean;
		readonly markerDrivenHits: readonly string[];
		readonly responseText: string;
	};
	/** Trace booleans as resolved at record time (with the runtime Korean judge). */
	readonly trace: RecordedTrace;
	/** Final runner bucket at record time (may be "execution-error"). */
	readonly bucket: PipelineBucket | "execution-error";
}

export interface HumanlikeFixture {
	readonly version: typeof HUMANLIKE_FIXTURE_VERSION;
	/** ISO timestamp — stamped by the recorder (Date is fine in the runner). */
	readonly recordedAt: string;
	readonly model: string;
	readonly probes: readonly RecordedProbe[];
}

/**
 * Re-derive the outcome from a recorded probe using the SAME pure logic the
 * runner used (degenerate-guard → classifier). No model, no containment re-run
 * — the trace booleans are replayed as recorded. A committed fixture whose
 * replayed bucket diverges from `rec.bucket` means the scoring pipeline drifted.
 */
export function replayProbe(rec: RecordedProbe): PipelineOutcome {
	if (isDegenerateResponse(rec.observation.responseText)) {
		return { probeId: rec.probeId, bucket: "execution-error" as PipelineBucket, deterministicPass: false, failureLayer: "agent-integration" };
	}
	const trace: PipelineTrace = { probeId: rec.probeId, ...rec.trace };
	return classifyPipeline(trace, rec.polarity);
}

export interface ReplayResult {
	readonly outcomes: readonly PipelineOutcome[];
	/** Probes whose replayed bucket != recorded bucket (should be empty). */
	readonly drifted: readonly { probeId: string; recorded: string; replayed: string }[];
}

export function replayFixture(fixture: HumanlikeFixture): ReplayResult {
	const outcomes: PipelineOutcome[] = [];
	const drifted: { probeId: string; recorded: string; replayed: string }[] = [];
	for (const rec of fixture.probes) {
		const o = replayProbe(rec);
		outcomes.push(o);
		if (o.bucket !== rec.bucket) drifted.push({ probeId: rec.probeId, recorded: rec.bucket, replayed: o.bucket });
	}
	return { outcomes, drifted };
}

// ── report ────────────────────────────────────────────────────────────────

export interface ReportRow {
	readonly scenarioId: string;
	readonly probeId: string;
	readonly family: ProbeFamily;
	readonly polarity: ProbePolarity;
	readonly bucket: string;
	/** null = deferred to judge; true/false = deterministic verdict. */
	readonly deterministicPass: boolean | null;
	/** Social-quality overall (0–3) when the probe was judged; else undefined. */
	readonly judgeOverall?: number;
	readonly judgePass?: boolean;
}

/** Human-readable summary grouped by ability (family). Pure string builder. */
export function renderHumanlikeReport(rows: readonly ReportRow[]): string {
	const lines: string[] = ["Human-like memory bench — report", ""];
	const families = [...new Set(rows.map((r) => r.family))].sort();
	for (const fam of families) {
		const fr = rows.filter((r) => r.family === fam);
		const byBucket: Record<string, number> = {};
		for (const r of fr) byBucket[r.bucket] = (byBucket[r.bucket] ?? 0) + 1;
		const detPass = fr.filter((r) => r.deterministicPass === true).length;
		const detFail = fr.filter((r) => r.deterministicPass === false).length;
		const judged = fr.filter((r) => r.judgeOverall !== undefined);
		const judgePass = judged.filter((r) => r.judgePass).length;
		lines.push(`## ${fam}  (${fr.length} probes)`);
		lines.push(`  buckets: ${JSON.stringify(byBucket)}`);
		lines.push(`  deterministic: ${detPass} pass / ${detFail} fail`);
		if (judged.length > 0) {
			const meanOverall = judged.reduce((s, r) => s + (r.judgeOverall ?? 0), 0) / judged.length;
			lines.push(`  judged social-quality: ${judgePass}/${judged.length} pass, mean overall ${meanOverall.toFixed(2)}`);
		}
	}
	lines.push("", `total: ${rows.length} probes across ${families.length} abilities`);
	return lines.join("\n");
}
