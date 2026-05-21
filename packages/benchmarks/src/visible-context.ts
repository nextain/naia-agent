/**
 * Visible-context builder — single source of truth for what the LLM judge
 * and the deterministic evaluator both see at probe time.
 *
 * Background (R6 audit invalidated R1-R5):
 *   - `runner.ts:evaluateProbe` and `mini-bench-judge.ts:extractVisibleContext`
 *     used divergent logic across R1-R5 patches. Each round's "alignment" fix
 *     re-opened a gap somewhere else.
 *   - R6 audit recommendation: a single shared function builds the visible
 *     context, both call sites import it, no per-site divergence possible.
 *
 * This module is that shared function.
 *
 * It is deliberately small: input → output, no I/O, no LLM. Pure.
 */

import type { Fixture, StrategyId } from "./fixture.js";

export interface VisibleContextInput {
	readonly fixture: Fixture;
	readonly strategy: StrategyId;
	/** Probe `afterTurn` index. 1-based to match fixture authoring. */
	readonly currentTurn: number;
	/** Recap text the strategy actually produced at the last compaction point.
	 *  Empty string when the strategy did not compact (off / no-op). */
	readonly recapContent: string;
	/** `keepTail` from the compaction call — number of turns preserved
	 *  verbatim by the summarizer immediately before the compaction point. */
	readonly keepTail: number;
	/** Provider-side context window cap in characters. 0 = no cap. */
	readonly contextWindowChars: number;
}

export interface VisibleContextOutput {
	/** Final string fed to LLM judge AND deterministic evaluator. Identical
	 *  for both call sites. */
	readonly visible: string;
	/** True when the strategy actually ran a compaction at some point ≤ currentTurn. */
	readonly wasCompacted: boolean;
	/** Last compactionPoint ≤ currentTurn, or undefined. */
	readonly lastCompactionPoint: number | undefined;
	/** Tail range [start, end) used to build the visible window. */
	readonly tailRange: { readonly start: number; readonly end: number };
	/** Whether the context-window cap actually fired. */
	readonly capApplied: boolean;
}

/**
 * Build the visible context the LLM judge sees AND the deterministic
 * evaluator scans for keywords. Single source of truth.
 *
 * Logic (R7 / Phase A unified):
 *
 *   1. Strategy class:
 *      - "off"            → no compaction ever ran. visible = full transcript
 *                           up to currentTurn, then `simulateContextWindow`.
 *      - compacted        → recap + verbatim tail.
 *
 *   2. For compacted strategies:
 *      - `lastCompactionPoint` = last compactionPoint ≤ currentTurn.
 *      - `tailStart` = max(0, lastCompactionPoint - keepTail).
 *        (The `keepTail` turns BEFORE the compaction point were kept
 *         verbatim by the summarizer; they're outside the recap.)
 *      - `tail` = turns[tailStart..currentTurn] role:content joined.
 *      - visible = "[recap]" + recapContent + "\n\n" + tail.
 *
 *   3. Context window cap:
 *      - Applied to FINAL visible string (recap + tail) uniformly for ALL
 *        strategies. No per-strategy exemption.
 *      - Right-aligned. Cut search prefers role-prefixed line starts
 *        (`user:`, `assistant:`, `tool:`, `system:`); falls back to nearest
 *        newline.
 *      - contextWindowChars = 0 disables the cap.
 *
 *   4. No fallback magic — if recapContent === "" for a compacted strategy
 *      (no-op prune / failed compact), visible is JUST the recap header +
 *      tail. There is no silent re-derivation from full transcript. That
 *      means a no-op `reactive-vercel` will look DIFFERENT from `off`,
 *      not identical.
 */
export function buildVisibleContext(input: VisibleContextInput): VisibleContextOutput {
	const { fixture, strategy, currentTurn, recapContent, keepTail, contextWindowChars } = input;

	const compactionPoints = fixture.compactionPoints ?? [];
	const lastCompactionPoint = [...compactionPoints]
		.filter((p) => p <= currentTurn)
		.sort((a, b) => a - b)
		.pop();

	const isCompactStrategy = strategy !== "off";
	const wasCompacted = isCompactStrategy && lastCompactionPoint !== undefined;

	let visible: string;
	let tailRange: { start: number; end: number };

	if (wasCompacted) {
		const tailStart = Math.max(0, (lastCompactionPoint as number) - keepTail);
		const tailEnd = currentTurn;
		tailRange = { start: tailStart, end: tailEnd };
		const tail = fixture.turns
			.slice(tailStart, tailEnd)
			.map((t) => `${t.role}: ${t.content}`)
			.join("\n");
		// Honest visible context: actual recap (may be "" for no-op) + tail.
		// No fallback to full transcript — if recap is empty, the model sees
		// just the tail and the strategy is judged on that.
		visible = `[recap]\n${recapContent}\n\n[tail]\n${tail}`;
	} else {
		// "off" or no compactionPoint yet — full transcript path. The cap is
		// the only thing that distinguishes off from a magic oracle.
		tailRange = { start: 0, end: currentTurn };
		visible = fixture.turns
			.slice(0, currentTurn)
			.map((t) => `${t.role}: ${t.content}`)
			.join("\n");
	}

	let capApplied = false;
	if (contextWindowChars > 0 && visible.length > contextWindowChars) {
		visible = applyContextWindowCap(visible, contextWindowChars);
		capApplied = true;
	}

	return {
		visible,
		wasCompacted,
		lastCompactionPoint,
		tailRange,
		capApplied,
	};
}

/**
 * Right-aligned truncation that prefers role-prefixed line starts so we
 * don't slice mid-message.
 */
function applyContextWindowCap(text: string, windowChars: number): string {
	if (text.length <= windowChars) return text;
	const tailStart = text.length - windowChars;
	const rolePrefixRe = /\n(user:|assistant:|tool:|system:)/g;
	rolePrefixRe.lastIndex = tailStart;
	const match = rolePrefixRe.exec(text);
	let start: number;
	if (match) {
		start = match.index + 1;
	} else {
		const nlAfter = text.indexOf("\n", tailStart);
		start = nlAfter !== -1 ? nlAfter + 1 : tailStart;
	}
	return `[context truncated by provider — ${(text.length - start)} of ${text.length} chars retained]\n${text.slice(start)}`;
}
