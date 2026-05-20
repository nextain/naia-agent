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

export type FixtureRole = "user" | "assistant" | "system";

export interface FixtureTurn {
	readonly role: FixtureRole;
	readonly content: string;
}

/** Compaction strategy identifier — wire-up locked in P2 (CompactionStrategy enum). */
export type StrategyId = "reactive" | "realtime" | "anthropic-native" | "off";

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
		if (t.role !== "user" && t.role !== "assistant" && t.role !== "system") {
			throw new Error(`fixture ${f.id}: turns[${i}].role invalid`);
		}
		if (typeof t.content !== "string") {
			throw new Error(`fixture ${f.id}: turns[${i}].content must be string`);
		}
	}
	if (!Array.isArray(f.probes)) {
		throw new Error(`fixture ${f.id}: probes must be an array`);
	}
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
	}
	return value as Fixture;
}
