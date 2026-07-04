import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	HUMANLIKE_FIXTURE_VERSION,
	renderHumanlikeReport,
	replayFixture,
	replayProbe,
	type HumanlikeFixture,
	type RecordedProbe,
	type ReportRow,
} from "../fixture.js";

const fixture: HumanlikeFixture = JSON.parse(
	readFileSync(new URL("../fixtures/humanlike-v1.fixture.json", import.meta.url), "utf8"),
);

describe("humanlike fixture replay (CI regression — no LLM)", () => {
	it("is the current fixture version and covers all 8 probes / 4 scenarios", () => {
		expect(fixture.version).toBe(HUMANLIKE_FIXTURE_VERSION);
		expect(fixture.probes.length).toBe(8);
		expect(new Set(fixture.probes.map((p) => p.scenarioId)).size).toBe(4);
	});

	it("replays every recorded probe to its recorded bucket (no scoring drift)", () => {
		const { drifted } = replayFixture(fixture);
		expect(drifted).toEqual([]);
	});

	it("negative probes that surfaced the memory are FAIL; abstentions are PASS", () => {
		for (const p of fixture.probes) {
			const o = replayProbe(p);
			if (p.polarity === "negative" && p.bucket === "forced-inappropriate") {
				expect(o.deterministicPass).toBe(false);
			}
			if (p.bucket === "abstained-correctly") {
				expect(o.deterministicPass).toBe(true);
			}
		}
	});

	it("renders a per-family report", () => {
		const rows: ReportRow[] = fixture.probes.map((p: RecordedProbe) => {
			const o = replayProbe(p);
			return { scenarioId: p.scenarioId, probeId: p.probeId, family: p.family, polarity: p.polarity, bucket: o.bucket, deterministicPass: o.deterministicPass };
		});
		const report = renderHumanlikeReport(rows);
		expect(report).toContain("emotion-association");
		expect(report).toContain("preference-application");
		expect(report).toContain("total: 8 probes across 2 abilities");
	});
});
