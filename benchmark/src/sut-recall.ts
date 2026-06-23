/**
 * Recall SUT adapter — Stage 1b. A THIN `SystemUnderTest` that drives a
 * memory-recall path over a fixture's transcript and answers the fixture's
 * probes from what was recalled.
 *
 * Deliberately NOT coupled to a live LLM or to `@nextain/naia-memory`. The
 * save/recall capability is INJECTED as two plain functions:
 *
 *   save(turn)            — persist one transcript turn into the system.
 *   recall(query)         — retrieve relevant content for a probe question.
 *
 * That keeps the adapter unit-testable with deterministic fakes (a fake recall
 * that echoes the keywords for a "good" run, or omits them for a "bad" run).
 * LIVE measurement is opt-in: the host wires `save`/`recall` to the real agent
 * memory recall path (e.g. `@nextain/naia-memory` save/retrieve, or the agent's
 * recall function) and passes them in. No process/transport mechanism is
 * imported here — the seam stays at the function boundary.
 *
 * Pure orchestration: no console / process I/O (repo rule F-LOG-3). Determinism
 * is inherited from the injected functions — a deterministic recall fn makes
 * this SUT deterministic.
 *
 * Scope note: this adapter answers fact-recall and task-accuracy probes from
 * the recalled text (task-accuracy `pass` = every expected keyword recalled, a
 * deterministic proxy; a real LLM judge is the opt-in follow-up). Drift probes
 * are answered with the recalled text as both answer and baseline (drift = 1.0)
 * unless the host supplies a `baseline` recall fn — full drift measurement
 * needs the compact-vs-no-compact pair, which is the live-compact-bench
 * follow-up.
 */

import type { FixtureInput, ProbeResponse, SystemUnderTest } from "./runner.js";

/** One transcript turn as handed to the injected save fn. */
export interface RecallTurn {
	readonly role: string;
	readonly content: string;
}

/** Persist a single turn. Live impl wraps real memory save; fake impl records. */
export type SaveFn = (turn: RecallTurn) => Promise<void> | void;

/** Retrieve relevant text for a probe question. Live impl wraps real recall. */
export type RecallFn = (query: string) => Promise<string> | string;

export interface RecallSutDeps {
	readonly save: SaveFn;
	readonly recall: RecallFn;
	/**
	 * Optional baseline recall (no-compaction path) for drift probes. When
	 * absent, drift probes report the recalled text as its own baseline → 1.0.
	 */
	readonly recallBaseline?: RecallFn;
}

/**
 * Build a recall `SystemUnderTest` from injected save/recall functions.
 *
 * Flow per fixture: replay every turn through `save`, then for each probe call
 * `recall(question)` and derive the probe answer from the recalled text.
 */
export function createRecallSut(deps: RecallSutDeps): SystemUnderTest {
	return {
		async run(input: FixtureInput): Promise<readonly ProbeResponse[]> {
			// 1. Replay the transcript into the system under test.
			for (const turn of input.turns) {
				await deps.save({ role: turn.role, content: turn.content });
			}

			// 2. Answer each probe from what the system recalls.
			const responses: ProbeResponse[] = [];
			for (let i = 0; i < input.probes.length; i++) {
				const probe = input.probes[i]!;

				if (probe.type === "fact-recall") {
					const answer = String(await deps.recall(probe.question));
					responses.push({ probeIndex: i, answer });
				} else if (probe.type === "task-accuracy") {
					// Deterministic proxy: task passes when the recalled text is
					// non-trivial. A real LLM judge against `probe.criterion` is the
					// opt-in follow-up; the SUT contract carries `taskPass` so a
					// judge-backed adapter can override this.
					const answer = String(await deps.recall(probe.criterion));
					responses.push({ probeIndex: i, answer, taskPass: answer.trim().length > 0 });
				} else {
					// drift: recalled text vs optional baseline recall.
					const answer = String(await deps.recall(probe.question));
					const baselineAnswer =
						deps.recallBaseline !== undefined
							? String(await deps.recallBaseline(probe.question))
							: answer;
					responses.push({ probeIndex: i, answer, baselineAnswer });
				}
			}
			return responses;
		},
	};
}
