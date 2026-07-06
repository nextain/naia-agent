import { describe, expect, it } from "vitest";
import { HUMANLIKE_SCENARIOS, SALIENCE_SCENARIOS } from "../scenarios.js";

describe("scenario turn well-formedness (all families)", () => {
	// Regression: a valence-fix edit once replaced a turn's `content:` line with a
	// comment, leaving content undefined → scoreImportance crashed on
	// `undefined.toLowerCase()` at live-seed time. Every turn must carry text.
	it("every turn in every scenario has non-empty string content", () => {
		for (const s of [...HUMANLIKE_SCENARIOS, ...SALIENCE_SCENARIOS]) {
			for (const sess of s.sessions) {
				for (const t of sess.turns) {
					expect(typeof t.content, `${s.id} / ${sess.label}`).toBe("string");
					expect((t.content ?? "").trim().length, `${s.id} / ${sess.label}`).toBeGreaterThan(0);
				}
			}
		}
	});
});

describe("HUMANLIKE_SCENARIOS well-formedness", () => {
	it("covers both human-like families with ≥2 emotion + ≥2 preference scenarios", () => {
		const byFamily = (f: string) => HUMANLIKE_SCENARIOS.filter((s) => s.family === f).length;
		expect(byFamily("emotion-association")).toBeGreaterThanOrEqual(2);
		expect(byFamily("preference-application")).toBeGreaterThanOrEqual(2);
	});

	it("every scenario has unique id, seed+distractor sessions, and a positive+negative probe pair", () => {
		const ids = new Set<string>();
		for (const s of HUMANLIKE_SCENARIOS) {
			expect(ids.has(s.id)).toBe(false);
			ids.add(s.id);
			// at least 2 seed + 1 distractor (design: seed2 + distractor1).
			expect(s.sessions.length).toBeGreaterThanOrEqual(3);
			const pol = s.probes.map((p) => p.polarity);
			expect(pol).toContain("positive");
			expect(pol).toContain("negative");
		}
	});

	it("every probe has a non-empty expectedMemorySet and a probe id unique within the scenario", () => {
		for (const s of HUMANLIKE_SCENARIOS) {
			const probeIds = new Set<string>();
			for (const p of s.probes) {
				expect(p.expectedMemorySet.length).toBeGreaterThan(0);
				expect(p.triggerText.length).toBeGreaterThan(0);
				expect(probeIds.has(p.id)).toBe(false);
				probeIds.add(p.id);
			}
		}
	});

	it("negative probes carry forbiddenRecalls (the creepy-DB guard has teeth)", () => {
		for (const s of HUMANLIKE_SCENARIOS) {
			for (const p of s.probes) {
				if (p.polarity === "negative") {
					expect(p.forbiddenRecalls && p.forbiddenRecalls.length > 0).toBe(true);
				}
			}
		}
	});

	it("anchor discipline: each expected anchor appears verbatim in the scenario's seed text (so it is recallable)", () => {
		for (const s of HUMANLIKE_SCENARIOS) {
			const seedText = s.sessions.flatMap((sess) => sess.turns.map((t) => t.content)).join(" ");
			for (const p of s.probes) {
				for (const anchor of p.expectedMemorySet) {
					expect(seedText.includes(anchor)).toBe(true);
				}
			}
		}
	});
});

describe("SALIENCE_SCENARIOS (HL-5c differential-salience) well-formedness", () => {
	it("carries reaction emotion tags: a high-emotion reacted memory + lower-emotion flat peers", () => {
		expect(SALIENCE_SCENARIOS.length).toBeGreaterThanOrEqual(1);
		for (const s of SALIENCE_SCENARIOS) {
			const emotions = s.sessions.flatMap((sess) => sess.turns.map((t) => (t as { emotion?: number }).emotion)).filter((e): e is number => e !== undefined);
			expect(emotions.length).toBeGreaterThan(0);
			expect(Math.max(...emotions)).toBeGreaterThanOrEqual(0.8); // a reacted-to memory (extreme valence)
			expect(Math.min(...emotions)).toBeLessThanOrEqual(0.5); // and flat/neutral peers (valence ~0.5)
		}
	});
	it("each carries +/- probes, forbiddenRecalls on negatives, and anchors present in seed text", () => {
		for (const s of SALIENCE_SCENARIOS) {
			const pol = s.probes.map((p) => p.polarity);
			expect(pol).toContain("positive");
			expect(pol).toContain("negative");
			const seedText = s.sessions.flatMap((sess) => sess.turns.map((t) => t.content)).join(" ");
			for (const p of s.probes) {
				for (const a of p.expectedMemorySet) expect(seedText.includes(a)).toBe(true);
				if (p.polarity === "negative") expect(p.forbiddenRecalls && p.forbiddenRecalls.length > 0).toBe(true);
			}
		}
	});
});
