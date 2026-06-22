/**
 * Conversational recall benchmark — deterministic judge + tiered gate.
 *
 * The conversational / agent-loop benchmark is naia-agent-owned: naia-memory
 * does retrieval-only bench; NL / dialogue judgment belongs to naia-agent.
 *
 * Reuses naia-memory's benchmark *pattern*, not its code (Interfaces, not
 * dependencies):
 *  - koIncludes / koNormalizeForJudge — deterministic Korean keyword judge.
 *    No external cloud LLM in the judge path.
 *  - TierGate { structureGate, accuracyMin, leakMax } — tiered acceptance.
 *
 * User directive (2026-05-20): a tiny model is NOT expected to emit a usable
 * marker reliably — for the SMALL tier we only check the structure *can occur
 * at all* (capability gate; low rate is fine, accuracy/leak are reported but NOT
 * gated). Strictness increases with model size: the MID tier additionally gates
 * round-trip accuracy + raw-marker leak.
 *
 * Ported faithfully from the pre-rewrite monorepo
 * (`packages/runtime/src/bench/recall-bench-judge.ts`). Pure module — no model,
 * no I/O, no cloud. No console / process I/O (repo rule F-LOG-3): every function
 * RETURNS its result (the tier verdict carries human-readable `reasons`).
 */

// ── Korean keyword judge ──────────────────────────────────────────────────

/** Verb-ending polarity synonyms (parity with naia-memory's judge). */
export const KO_SYNONYM_MAP: ReadonlyArray<readonly [RegExp, string]> = [
	[/마셔$/, "마심"],
	[/마셔요$/, "마심"],
	[/안 마셔$/, "안 마심"],
	[/안 마셔요$/, "안 마심"],
	[/안 펴$/, "안 함"],
	[/안 피워$/, "안 함"],
	[/없어$/, "없음"],
	[/없어요$/, "없음"],
	[/안 먹어$/, "안 먹음"],
	[/안 먹어요$/, "안 먹음"],
	[/안 가$/, "안 감"],
	[/안 해$/, "안 함"],
	[/안 해요$/, "안 함"],
	[/안 친해$/, "안 친함"],
	[/안 나가$/, "안 나감"],
	[/챙겨 먹어$/, "챙겨 먹음"],
	[/자주 안 바꿔$/, "자주 안 바꿈"],
	[/안 해$/, "안 해요"],
];

export function koNormalizeForJudge(text: string): string {
	return text.replace(/\(변경\)/g, "").toLowerCase().trim();
}

/** Korean-aware containment judge (naia-memory parity). */
export function koIncludes(haystack: string, needle: string): boolean {
	const h = koNormalizeForJudge(haystack);
	const n = koNormalizeForJudge(needle);
	if (h.includes(n)) return true;
	for (const [pat, repl] of KO_SYNONYM_MAP) {
		if (pat.test(h) && h.replace(pat, repl).includes(n)) return true;
		if (pat.test(n) && h.includes(n.replace(pat, repl))) return true;
	}
	return false;
}

// ── Marker structure / leak detectors ─────────────────────────────────────

/**
 * A *well-formed* recall marker (the v2 contract the model is asked to emit).
 * Matched against the model's raw TEXT-channel output (pre-strip). Bound is
 * {2,256} — a 1-char marker is inert in production so it must not count as a
 * capable structure here.
 */
export const WELL_FORMED_MARKER = /<recall>\s*[\s\S]{2,256}?<\/recall>/i;

/**
 * Loose marker-ish residue in the *final user-facing answer*. Catches the
 * failure where a tiny model emits a MALFORMED marker (e.g.
 * `<recal<...</recal>`) that the strict parser rightly does not match and
 * therefore leaks verbatim to the user. Looser than WELL_FORMED on purpose.
 */
export const LOOSE_MARKER_LEAK = /<\s*\/?\s*reca/i;

// ── Tiered gate ───────────────────────────────────────────────────────────

export interface TrialResult {
	/** RAW model output contained a well-formed <recall>q</recall>. */
	markerWellFormed: boolean;
	/** Final answer contains the expected fact keyword (koIncludes). */
	roundTrip: boolean;
	/** Final answer still contains marker-ish residue (leak bug). */
	leaked: boolean;
}

export interface TierGate {
	id: "small" | "mid";
	/** Min number of trials (absolute count) with a well-formed marker. */
	structureGate: number;
	/** Min round-trip accuracy RATE (0..1); null = report-only, not gated. */
	accuracyMin: number | null;
	/** Max marker-leak RATE (0..1); null = report-only, not gated. */
	leakMax: number | null;
}

/**
 * SMALL = capability only: prove the structure can occur ≥1 time. Accuracy /
 * leak reported but NOT gated. MID = stricter: also gate round-trip accuracy +
 * leak rate. (No `large` tier — add one only when a concrete bigger-tier model
 * exists, with its own unit test.)
 */
export const TIER_GATES: Record<TierGate["id"], TierGate> = {
	small: { id: "small", structureGate: 1, accuracyMin: null, leakMax: null },
	mid: { id: "mid", structureGate: 3, accuracyMin: 0.4, leakMax: 0.2 },
};

/** Map an Ollama model id → tier. Unknown → small (conservative). */
export function tierForModel(model: string): TierGate {
	const m = model.toLowerCase();
	if (m.includes("e2b")) return TIER_GATES.small;
	if (m.includes("e4b")) return TIER_GATES.mid;
	return TIER_GATES.small;
}

export interface TierVerdict {
	pass: boolean;
	trials: number;
	structureCount: number;
	accuracyRate: number;
	leakRate: number;
	/** Human-readable gate decisions (always lists every checked clause). */
	reasons: string[];
}

/** Pure aggregation + tier-gate decision. */
export function evaluateTier(trials: TrialResult[], gate: TierGate): TierVerdict {
	const n = trials.length;
	const structureCount = trials.filter((t) => t.markerWellFormed).length;
	const accuracyRate = n ? trials.filter((t) => t.roundTrip).length / n : 0;
	const leakRate = n ? trials.filter((t) => t.leaked).length / n : 0;
	const reasons: string[] = [];

	const structOk = structureCount >= gate.structureGate;
	reasons.push(
		`structure ${structureCount}/${n} >= ${gate.structureGate} → ${structOk ? "OK" : "FAIL"}`,
	);

	let accOk = true;
	if (gate.accuracyMin === null) {
		reasons.push(`accuracy ${(accuracyRate * 100).toFixed(0)}% (report-only)`);
	} else {
		accOk = accuracyRate >= gate.accuracyMin;
		reasons.push(
			`accuracy ${(accuracyRate * 100).toFixed(0)}% >= ${(gate.accuracyMin * 100).toFixed(0)}% → ${accOk ? "OK" : "FAIL"}`,
		);
	}

	let leakOk = true;
	if (gate.leakMax === null) {
		reasons.push(`leak ${(leakRate * 100).toFixed(0)}% (report-only)`);
	} else {
		leakOk = leakRate <= gate.leakMax;
		reasons.push(
			`leak ${(leakRate * 100).toFixed(0)}% <= ${(gate.leakMax * 100).toFixed(0)}% → ${leakOk ? "OK" : "FAIL"}`,
		);
	}

	return {
		pass: structOk && accOk && leakOk,
		trials: n,
		structureCount,
		accuracyRate,
		leakRate,
		reasons,
	};
}
