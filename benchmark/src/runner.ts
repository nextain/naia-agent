/**
 * Benchmark runner — Stage 1b. The piece that makes the Stage-1a deterministic
 * scoring core *runnable*: fixture → system-under-test → score → result.
 *
 * GENERIC + system-agnostic. The runner does NOT know about MemorySystem, an
 * LLM, a subprocess, or any concrete backend. The system being measured is
 * supplied as an injected `SystemUnderTest`. Given a deterministic SUT this
 * runner is itself deterministic (same fixture + same SUT → identical result):
 * it adds no clock, no randomness, no I/O, no console.
 *
 * Contrast with the pre-rewrite monorepo runner
 * (`packages/benchmarks/src/runner.ts`), which hard-wired
 * `MemorySystem.compact()` across strategies and used `performance.now()` /
 * `fs` directly. Stage 1b extracts the orchestration shape (drive fixture turns,
 * collect per-probe responses, score with the 1a metrics) and pushes every
 * non-deterministic / system-specific concern out behind the SUT seam. A live
 * MemorySystem run is then just one SUT implementation a host injects.
 *
 * Scoring is NOT re-implemented here — it reuses Stage 1a exactly:
 *   - fact-recall  → strict keyword survival (every expectedKeyword present),
 *     aggregated by `factRecall` from metrics.ts.
 *   - task-accuracy → per-probe pass via the injected SUT's own judgement,
 *     aggregated by `taskAccuracy`.
 *   - drift        → `driftScore` (Jaccard) between the compact-path answer and
 *     the no-compact baseline answer the SUT reports.
 *
 * No console / process I/O (repo rule F-LOG-3): every function RETURNS its data.
 */

import type { Fixture, FixtureProbe } from "./fixture.js";
import { validateFixture } from "./fixture.js";
import { factRecall, taskAccuracy, driftScore, type ProbeJudgement } from "./metrics.js";

// ── SUT contract (the injected seam) ──────────────────────────────────────

/**
 * What the runner hands the system under test: the fixture's transcript plus
 * the probes to answer. Defined minimally from the fixture schema — the SUT
 * decides how to consume the turns (compact, retrieve, replay, …).
 */
export interface FixtureInput {
	readonly fixtureId: string;
	readonly domain: string;
	readonly turns: Fixture["turns"];
	readonly probes: Fixture["probes"];
	readonly compactionPoints: readonly number[];
}

/** A single probe answer produced by the SUT. */
export interface ProbeResponse {
	/** Identifies which probe this answers (index into FixtureInput.probes). */
	readonly probeIndex: number;
	/** The system's final user-facing answer to the probe. */
	readonly answer: string;
	/**
	 * For task-accuracy probes only: the SUT's own pass judgement (the runner
	 * does NOT LLM-judge — the SUT, or an adapter wrapping a judge, decides).
	 * Ignored for fact-recall (scored by keyword survival) and drift.
	 */
	readonly taskPass?: boolean;
	/**
	 * For drift probes only: the baseline (no-compact) answer to compare against.
	 * REQUIRED on a drift probe — if omitted, the probe fails closed(드리프트 측정 불가,
	 * "no baseline → perfect" 금지). 드리프트는 compact-path 답 vs 이 baseline 의 Jaccard.
	 */
	readonly baselineAnswer?: string;
}

/**
 * The system being measured. ONE method: take the fixture input, return one
 * response per probe. Everything system-specific (memory, LLM, subprocess)
 * lives behind this. A deterministic implementation makes the whole run
 * deterministic; a live implementation is opt-in by the host.
 */
export interface SystemUnderTest {
	run(input: FixtureInput): Promise<readonly ProbeResponse[]>;
}

// ── Result shape ───────────────────────────────────────────────────────────

export interface FixtureScores {
	/** 0..1 — strict fact-recall (every keyword survives, per probe). */
	readonly factRecall: number;
	/** 0..1 — task-accuracy per-probe pass rate (SUT-judged). */
	readonly taskAccuracy: number;
	/** 0..1 — drift vs baseline (1 = identical, lower = divergent). */
	readonly driftScore: number;
}

export interface ProbeDetail {
	readonly probeIndex: number;
	readonly type: FixtureProbe["type"];
	readonly pass: boolean;
	/** Short human-readable note (which keywords missed, drift value, etc.). */
	readonly note: string;
}

export interface FixtureResult {
	readonly fixtureId: string;
	readonly scores: FixtureScores;
	/** Overall pass: all scored axes meet the threshold. */
	readonly pass: boolean;
	readonly details: readonly ProbeDetail[];
	/** Non-fatal issues (missing probe response, etc.) — surfaced, not thrown. */
	readonly errors: readonly string[];
}

/**
 * Pass thresholds. Defaults are strict (the point of the bench is to surface
 * regression): fact-recall and task-accuracy must be perfect, drift must stay
 * at-or-above `driftMin`. A host may relax these per run.
 */
export interface PassThresholds {
	readonly factRecallMin: number;
	readonly taskAccuracyMin: number;
	readonly driftMin: number;
}

export const DEFAULT_THRESHOLDS: PassThresholds = {
	factRecallMin: 1.0,
	taskAccuracyMin: 1.0,
	driftMin: 0.5,
};

// ── Runner ─────────────────────────────────────────────────────────────────

function toInput(fixture: Fixture): FixtureInput {
	return {
		fixtureId: fixture.id,
		domain: fixture.domain,
		turns: fixture.turns,
		probes: fixture.probes,
		compactionPoints: fixture.compactionPoints ?? [],
	};
}

/** Strict keyword survival for a fact-recall probe. */
function scoreFactRecallProbe(
	probe: Extract<FixtureProbe, { type: "fact-recall" }>,
	answer: string,
): { pass: boolean; note: string } {
	const lower = answer.toLowerCase();
	const missing = probe.expectedKeywords.filter((k) => !lower.includes(k.toLowerCase()));
	return {
		pass: missing.length === 0,
		note:
			missing.length === 0
				? `all ${probe.expectedKeywords.length} keyword(s) present`
				: `missing keyword(s): ${missing.join(", ")}`,
	};
}

/**
 * Drive one fixture through the injected SUT and score it deterministically
 * with the Stage-1a metrics. Pure given a pure SUT — no clock, no randomness,
 * no I/O. Validates the fixture first so malformed input fails loudly.
 */
export async function runFixture(
	fixture: Fixture,
	sut: SystemUnderTest,
	thresholds: PassThresholds = DEFAULT_THRESHOLDS,
): Promise<FixtureResult> {
	const validated = validateFixture(fixture);
	const input = toInput(validated);
	const errors: string[] = [];
	const details: ProbeDetail[] = [];
	const factJudgements: ProbeJudgement[] = [];
	const taskJudgements: ProbeJudgement[] = [];
	const driftValues: number[] = [];
	// 구조적 실패(응답 누락·drift baseline 누락)는 score 가 아니라 데이터/시스템 결함 →
	// threshold 와 무관하게 unconditional fail(적대리뷰 R2 #1 — driftMin 완화로 우회 금지).
	let fatal = false;

	let responses: readonly ProbeResponse[];
	try {
		responses = await sut.run(input);
	} catch (e) {
		// SUT throw/reject = 시스템 실패 → fail-closed(크래시 아님, 적대리뷰 #1). 전 probe fail + 에러.
		return {
			fixtureId: validated.id,
			scores: { factRecall: 0, taskAccuracy: 0, driftScore: 0 },
			pass: false,
			details: validated.probes.map((p, i) => ({ probeIndex: i, type: p.type, pass: false, note: "SUT error" })),
			errors: [`SUT run threw: ${e instanceof Error ? e.message : String(e)}`],
		};
	}

	// Index responses by probe. 중복 probeIndex = SUT 버그 → 에러 표면화(적대리뷰 #5, last wins).
	const byProbe = new Map<number, ProbeResponse>();
	for (const r of responses) {
		if (byProbe.has(r.probeIndex)) errors.push(`duplicate response for probe ${r.probeIndex} (last wins)`);
		byProbe.set(r.probeIndex, r);
	}

	for (let i = 0; i < validated.probes.length; i++) {
		const probe = validated.probes[i]!;
		const resp = byProbe.get(i);

		if (resp === undefined) {
			// Missing response = the SUT failed to answer this probe → fail closed(구조적, fatal).
			errors.push(`probe ${i} (${probe.type}): no response from SUT`);
			fatal = true;
			details.push({ probeIndex: i, type: probe.type, pass: false, note: "no response" });
			if (probe.type === "fact-recall") {
				factJudgements.push({ probe, response: "", pass: false });
			} else if (probe.type === "task-accuracy") {
				taskJudgements.push({ probe, response: "", pass: false });
			} else {
				driftValues.push(0);
			}
			continue;
		}

		if (probe.type === "fact-recall") {
			const { pass, note } = scoreFactRecallProbe(probe, resp.answer);
			factJudgements.push({ probe, response: resp.answer, pass });
			details.push({ probeIndex: i, type: probe.type, pass, note });
		} else if (probe.type === "task-accuracy") {
			const pass = resp.taskPass === true;
			taskJudgements.push({ probe, response: resp.answer, pass });
			details.push({
				probeIndex: i,
				type: probe.type,
				pass,
				note: resp.taskPass === undefined ? "SUT gave no task judgement → fail" : `SUT judged ${pass ? "pass" : "fail"}`,
			});
		} else {
			// drift: SUT 의 compact-path 답 vs baseline(no-compact). baseline 없으면 발산 측정 불가 →
			// fail-closed(적대리뷰 #2 — "no baseline → perfect" 금지).
			if (resp.baselineAnswer === undefined) {
				errors.push(`probe ${i} (drift): no baseline answer → cannot measure drift`);
				fatal = true;
				driftValues.push(0);
				details.push({ probeIndex: i, type: probe.type, pass: false, note: "no baseline → fail" });
			} else {
				const drift = driftScore(resp.answer, resp.baselineAnswer);
				driftValues.push(drift);
				details.push({ probeIndex: i, type: probe.type, pass: drift >= thresholds.driftMin, note: `drift=${drift.toFixed(3)}` });
			}
		}
	}

	const fr = factRecall(factJudgements);
	const ta = taskAccuracy(taskJudgements);
	// Aggregate drift = MIN(worst probe) — mean 이 per-probe 실패를 마스킹하지 않게(적대리뷰 #3:
	// [0.0,1.0] 의 mean 0.5 가 driftMin 0.5 를 통과하던 문제). 드리프트 probe 없으면 1.0(무관).
	const dr = driftValues.reduce((a, b) => Math.min(a, b), 1.0); // min(worst); spread 회피(대량 probe arg 한계, 적대리뷰 R2 #2). 빈 배열=1.0.

	// An axis only gates if the fixture exercises it (has ≥1 probe of that type).
	const hasFact = factJudgements.length > 0;
	const hasTask = taskJudgements.length > 0;
	const hasDrift = driftValues.length > 0;
	const pass =
		!fatal && // 구조적 실패(응답/baseline 누락)는 threshold 무관 unconditional fail(적대리뷰 R2 #1)
		(!hasFact || fr >= thresholds.factRecallMin) &&
		(!hasTask || ta >= thresholds.taskAccuracyMin) &&
		(!hasDrift || dr >= thresholds.driftMin);

	return {
		fixtureId: validated.id,
		scores: { factRecall: fr, taskAccuracy: ta, driftScore: dr },
		pass,
		details,
		errors,
	};
}

/**
 * Drive many fixtures through the same SUT. Order-preserving; each fixture is
 * independent so a failure in one does not abort the rest (errors are carried
 * on the per-fixture result, never thrown across the batch).
 */
export async function runFixtures(
	fixtures: readonly Fixture[],
	sut: SystemUnderTest,
	thresholds: PassThresholds = DEFAULT_THRESHOLDS,
): Promise<readonly FixtureResult[]> {
	const out: FixtureResult[] = [];
	for (const fx of fixtures) {
		out.push(await runFixture(fx, sut, thresholds));
	}
	return out;
}
