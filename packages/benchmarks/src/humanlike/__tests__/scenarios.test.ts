import { describe, expect, it } from "vitest";
import { HUMANLIKE_SCENARIOS } from "../scenarios.js";

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
