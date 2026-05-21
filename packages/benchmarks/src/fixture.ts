/**
 * Fixture schema for compaction benchmarks — Slice 3-XR-Compact P1.
 *
 * Self-contained types so this package does not depend on @nextain/agent-core's
 * internal message shapes. The runner adapts FixtureTurn → core LLMMessage
 * at execution time.
 *
 * Source format (JSON files in `src/fixtures/`):
 *
 *   {
 *     "id": "F001-customer-support-50turn",
 *     "domain": "customer-support",
 *     "turns": [ { "role": "user", "content": "..." }, ... ],
 *     "probes": [ ... ],
 *     "compactionPoints": [25, 45]
 *   }
 */

export type FixtureRole = "user" | "assistant" | "system" | "tool";

export interface FixtureTurn {
	readonly role: FixtureRole;
	readonly content: string;
}

/** Compaction strategy identifier.
 *
 *  R7 Phase A (commit 09d3fdb replan): `anthropic-native` REMOVED from the
 *  benchmark per gemini R6 audit ("placebo mimicking off"). It was a
 *  `return undefined` sentinel — no API call, no measurement. plan §3 P1
 *  deferred until `@ai-sdk/anthropic` + beta header `compact-2026-01-12` is
 *  actually wired in a separate effort.
 *
 *  Current 4 strategies:
 *   - `off`             : no compaction, full transcript subject to context-window cap
 *   - `reactive`        : naia-memory `compact()` — 5-section markdown summarization
 *   - `reactive-vercel` : Vercel AI SDK `pruneMessages` — strips reasoning + old tool_calls
 *   - `realtime`        : naia-memory `compact()` with per-turn encode (rolling summary) */
export type StrategyId =
	| "reactive"
	| "reactive-vercel"
	| "realtime"
	| "off";

/**
 * Fixture probe — injected at `afterTurn` to measure post-compaction behavior.
 *
 * `fact-recall`: probes a fact established earlier in the dialog. `expectedKeywords`
 * is checked first (cheap string match); `criterion` is a fallback LLM-judge prompt.
 *
 * `task-accuracy`: open-ended LLM-judge probe. Most expensive metric.
 *
 * `drift`: re-issues the same probe in two parallel runs (compact vs no-compact),
 * compares responses for semantic equivalence (cosine + LLM-judge agreement).
 */
export type FixtureProbe =
	| {
			readonly afterTurn: number;
			readonly type: "fact-recall";
			readonly question: string;
			readonly expectedKeywords: readonly string[];
			readonly criterion?: string;
	  }
	| {
			readonly afterTurn: number;
			readonly type: "task-accuracy";
			readonly criterion: string;
			/**
			 * Explicit question for the LLM judge. REQUIRED in R7 — silent
			 * fallback to "last user turn" was a R5 framing artefact that
			 * judged a different prompt than the fixture author intended.
			 */
			readonly question: string;
			/**
			 * R7 (gemini R6 audit): explicit 1-based turn indices where the
			 * fact(s) required to answer this probe are established in the
			 * fixture. Used by the harness to validate that the strategy
			 * under test actually has to preserve the fact (i.e. fact is in
			 * the recap range, not in the preserved tail).
			 *
			 * If empty / undefined, the probe is treated as "tail-trivial"
			 * — answerable from the preserved tail without compaction
			 * effort. Such probes can still be measured but are reported in
			 * a separate column (NOT as strategy quality).
			 *
			 * Authoring rule: include EVERY turn where the fact (or a
			 * close paraphrase) appears. The harness will classify the
			 * probe by where those turns fall relative to `lastCompactionPoint`
			 * and `keepTail`.
			 */
			readonly factTurns?: readonly number[];
	  }
	| {
			readonly afterTurn: number;
			readonly type: "drift";
			readonly question: string;
	  };

export interface Fixture {
	readonly id: string;
	readonly domain: string;
	readonly turns: readonly FixtureTurn[];
	readonly probes: readonly FixtureProbe[];
	/** Turn indices at which compaction is forced (for deterministic comparison). */
	readonly compactionPoints?: readonly number[];
	/** Optional notes for fixture authors. */
	readonly notes?: string;
}

/** Single per-fixture result before aggregation. */
export interface FixtureResult {
	readonly fixtureId: string;
	readonly strategy: StrategyId;
	readonly taskAccuracy: number; // 0..1, per-probe pass rate
	readonly factRecall: number; // 0..1
	readonly latencyP50Ms: number;
	readonly latencyP99Ms: number;
	readonly compactionLatencyMs: number;
	readonly totalTokens: number;
	readonly driftScore: number; // 0..1, 1 = identical to no-compact baseline
	readonly errors: readonly string[];
	/**
	 * Phase 1.3 (#56) — actual post-compaction recap content (or empty for
	 * `off` / `anthropic-native` / no-op `reactive-vercel`). Exposed so
	 * downstream LLM-judge harnesses can feed judges the **real** visible
	 * window rather than reconstructing it from fixture tails. Fixes the
	 * R1 unfairness where `reactive` (5-section markdown) and
	 * `reactive-vercel` (plain pruned messages) were shown to judges as
	 * identical sliced-fixture text.
	 */
	readonly recapContent?: string;
}

/**
 * Light-weight runtime schema validator. Throws on malformed fixtures so
 * authoring mistakes surface immediately rather than at probe time.
 */
export function validateFixture(value: unknown): Fixture {
	if (typeof value !== "object" || value === null) {
		throw new Error("fixture: must be an object");
	}
	const f = value as Record<string, unknown>;
	if (typeof f.id !== "string" || f.id.length === 0) {
		throw new Error("fixture: id must be a non-empty string");
	}
	if (typeof f.domain !== "string") {
		throw new Error(`fixture ${f.id}: domain must be a string`);
	}
	if (!Array.isArray(f.turns) || f.turns.length === 0) {
		throw new Error(`fixture ${f.id}: turns must be a non-empty array`);
	}
	for (const [i, turn] of f.turns.entries()) {
		if (typeof turn !== "object" || turn === null) {
			throw new Error(`fixture ${f.id}: turns[${i}] is not an object`);
		}
		const t = turn as Record<string, unknown>;
		if (
			t.role !== "user" &&
			t.role !== "assistant" &&
			t.role !== "system" &&
			t.role !== "tool"
		) {
			throw new Error(`fixture ${f.id}: turns[${i}].role invalid`);
		}
		if (typeof t.content !== "string") {
			throw new Error(`fixture ${f.id}: turns[${i}].content must be string`);
		}
	}
	if (!Array.isArray(f.probes)) {
		throw new Error(`fixture ${f.id}: probes must be an array`);
	}
	// Validate each probe shape FIRST (so "invalid type" errors surface
	// before the structural "must have task-accuracy" check below).
	for (const [i, probe] of f.probes.entries()) {
		if (typeof probe !== "object" || probe === null) {
			throw new Error(`fixture ${f.id}: probes[${i}] is not an object`);
		}
		const p = probe as Record<string, unknown>;
		if (typeof p.afterTurn !== "number" || p.afterTurn < 0) {
			throw new Error(`fixture ${f.id}: probes[${i}].afterTurn invalid`);
		}
		if (p.type !== "fact-recall" && p.type !== "task-accuracy" && p.type !== "drift") {
			throw new Error(`fixture ${f.id}: probes[${i}].type invalid`);
		}
		if (p.type === "task-accuracy") {
			// R7: question is REQUIRED for task-accuracy probes (no silent
			// "last user turn" fallback — that was a R5 framing artefact).
			if (typeof p.question !== "string" || p.question.length === 0) {
				throw new Error(
					`fixture ${f.id}: probes[${i}].question is required for task-accuracy`,
				);
			}
			if (p.factTurns !== undefined) {
				if (!Array.isArray(p.factTurns)) {
					throw new Error(
						`fixture ${f.id}: probes[${i}].factTurns must be an array of turn indices`,
					);
				}
				for (const t of p.factTurns) {
					if (typeof t !== "number" || t < 1) {
						throw new Error(
							`fixture ${f.id}: probes[${i}].factTurns entries must be 1-based positive turn indices`,
						);
					}
				}
			}
		}
	}
	// R7 (gemini R6 audit Finding #6): strict — at least one task-accuracy
	// probe required. R1-R5 silent fallback hid authoring errors where a
	// fixture with zero probes still produced "PASS" rows.
	const hasTaskProbe = f.probes.some(
		(p) => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "task-accuracy",
	);
	if (!hasTaskProbe) {
		throw new Error(
			`fixture ${f.id}: must define at least one probe of type "task-accuracy"`,
		);
	}
	return value as Fixture;
}

/**
 * Probe stress classification — R7 Phase A4.
 *
 * Given a task-accuracy probe's `factTurns` and the fixture's compaction
 * geometry (`lastCompactionPoint`, `keepTail`), classify whether the probe
 * actually stresses the strategy:
 *
 *   - "recap-only": every fact-turn is in turns[0..lastCompactionPoint-keepTail].
 *     The strategy MUST preserve the fact through compaction; this is a
 *     genuine strategy-quality probe.
 *
 *   - "tail-trivial": at least one fact-turn is in the preserved tail
 *     (turns[lastCompactionPoint-keepTail..currentTurn]). The strategy is
 *     not stressed; off can answer just as well as reactive.
 *
 *   - "no-compaction": no compactionPoint ≤ currentTurn, so no compaction
 *     ran. Probe measures the cap, not the strategy.
 *
 *   - "unclassified": `factTurns` is undefined or empty.
 */
export function classifyProbeStress(
	factTurns: readonly number[] | undefined,
	lastCompactionPoint: number | undefined,
	keepTail: number,
): "recap-only" | "tail-trivial" | "no-compaction" | "unclassified" {
	if (lastCompactionPoint === undefined) return "no-compaction";
	if (factTurns === undefined || factTurns.length === 0) return "unclassified";
	const tailStart = Math.max(0, lastCompactionPoint - keepTail);
	const anyInTail = factTurns.some((t) => t > tailStart);
	return anyInTail ? "tail-trivial" : "recap-only";
}
