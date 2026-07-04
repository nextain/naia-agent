/**
 * Human-like memory bench — pure observation → PipelineTrace mapping.
 *
 * The live runner (examples/humanlike-memory-bench.ts) drives the real agent
 * and collects three raw observations per probe:
 *   1. markerEmitted     — did the agent emit a `<recall>…</recall>` marker
 *                          (deliberate recall DECISION)? Read from the tee'd
 *                          raw LLM text channel — exactly what agent.ts's
 *                          marker parser can act on.
 *   2. markerDrivenHits  — the memories the store returned for the agent's
 *                          marker-driven recall(s). Start-of-turn recall is
 *                          isolated (returns []) so these hits exist ONLY when
 *                          a marker actually fired — clean layer attribution.
 *   3. responseText      — the final user-facing answer (turn.ended).
 *
 * This module turns those into the DETERMINISTIC PipelineTrace booleans that
 * `classifyPipeline` consumes. It is pure (no model, no I/O) and unit-tested;
 * the Korean-aware containment predicate is injected so this module stays free
 * of the runtime package (the live runner passes `koIncludes`).
 */
import type { HumanlikeProbe, PipelineTrace } from "./types.js";

/** Containment predicate: does `haystack` mention the memory anchor `needle`?
 *  Injected so the pure core does not depend on the runtime's Korean judge. */
export type Contains = (haystack: string, needle: string) => boolean;

/**
 * The agent produced no usable answer — empty text, or an internal stop/abort/
 * halt stub (agent.ts emits "[agent stopped …]" / "[agent aborted]" /
 * "[agent halted …]" when a turn yields no final text). Such a turn is an
 * EXECUTION failure and must NOT be scored as a clean pass/abstain — otherwise
 * a non-response on a negative probe false-passes as "abstained-correctly".
 * Bench-layer soundness guard (does not alter the pure classifier).
 */
export function isDegenerateResponse(text: string): boolean {
	const t = text.trim();
	if (t.length === 0) return true;
	return /^\[agent (stopped|aborted|halted)/i.test(t);
}

/** Raw, deterministic observations the live runner collected for one probe. */
export interface ProbeObservation {
	readonly probeId: string;
	/** Agent emitted a `<recall>…</recall>` marker (from the tee'd raw text). */
	readonly markerEmitted: boolean;
	/** Contents of memories returned by marker-driven recall(s) this turn. */
	readonly markerDrivenHits: readonly string[];
	/** Final user-facing response text. */
	readonly responseText: string;
}

/** Map raw observations + the probe's expected/forbidden sets into a trace. */
export function buildTrace(
	obs: ProbeObservation,
	probe: Pick<HumanlikeProbe, "expectedMemorySet" | "forbiddenRecalls">,
	contains: Contains,
): PipelineTrace {
	const anyExpected = (text: string): boolean =>
		probe.expectedMemorySet.some((m) => contains(text, m));

	const targetRetrieved = obs.markerDrivenHits.some((h) => anyExpected(h));
	const targetUsed = anyExpected(obs.responseText);
	const forbiddenSurfaced = (probe.forbiddenRecalls ?? []).some((f) =>
		contains(obs.responseText, f),
	);

	return {
		probeId: obs.probeId,
		recallAttempted: obs.markerEmitted,
		targetRetrieved,
		targetUsed,
		forbiddenSurfaced,
		responseText: obs.responseText,
	};
}
