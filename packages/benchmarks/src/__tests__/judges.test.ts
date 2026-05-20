// Slice 3-XR-Compact follow-up (#48) — judge prompt + parse + ensemble unit.
//
// LIVE judge invocation (network / CLI subprocess) is gated to opt-in
// scripts (smoke:judges:live) — runs against real GLM HTTP + codex CLI +
// opencode CLI + gemini CLI. This file covers the deterministic core.

import { describe, expect, it } from "vitest";
import {
	buildJudgePrompt,
	parseJudgeReply,
	runEnsemble,
	isInfraError,
} from "../judges/index.js";
import type { Judge, JudgeInput, JudgeResult } from "../judges/index.js";

const SAMPLE: JudgeInput = {
	question: "What is the order number?",
	response: "Order #A-7421, customer Jane Doe.",
	criterion: "Response correctly states order #A-7421",
};

describe("Judge prompt + parser (Slice 3-XR-Compact #48)", () => {
	it("JG-PR-01: buildJudgePrompt includes question, response, criterion verbatim", () => {
		const p = buildJudgePrompt(SAMPLE);
		expect(p).toContain("What is the order number?");
		expect(p).toContain("#A-7421");
		expect(p).toContain("Response correctly states order #A-7421");
		// Strict-format directive present
		expect(p).toContain("PASS:");
		expect(p).toContain("FAIL:");
	});

	it("JG-PR-02: parseJudgeReply accepts leading 'PASS: ...' line", () => {
		const v = parseJudgeReply("PASS: response contains the exact order id.", 12);
		expect(v).not.toBeNull();
		expect(v!.pass).toBe(true);
		expect(v!.reason).toContain("exact order id");
		expect(v!.latencyMs).toBe(12);
	});

	it("JG-PR-03: parseJudgeReply accepts 'FAIL: ...'", () => {
		const v = parseJudgeReply("FAIL: response mentions wrong number", 5);
		expect(v).not.toBeNull();
		expect(v!.pass).toBe(false);
	});

	it("JG-PR-04: parser strips surrounding noise and picks first matching line", () => {
		const text = [
			"Some preamble noise the judge added.",
			"PASS: criterion satisfied — id #A-7421 explicit.",
			"trailing chatter",
		].join("\n");
		const v = parseJudgeReply(text, 0);
		expect(v).not.toBeNull();
		expect(v!.pass).toBe(true);
		expect(v!.reason).toContain("criterion satisfied");
	});

	it("JG-PR-05: parser returns null on missing PASS/FAIL marker", () => {
		expect(parseJudgeReply("the response was kinda ok", 0)).toBeNull();
	});

	it("JG-PR-06: parser tolerates case + alternative separators", () => {
		const v1 = parseJudgeReply("pass - looks good", 0);
		expect(v1?.pass).toBe(true);
		const v2 = parseJudgeReply("Fail. wrong", 0);
		expect(v2?.pass).toBe(false);
	});
});

describe("Ensemble majority + infra-error handling (#48)", () => {
	function fakeJudge(verdict: "PASS" | "FAIL" | "INFRA"): Judge {
		return async (): Promise<JudgeResult> => {
			if (verdict === "INFRA") {
				return { infraError: "simulated", latencyMs: 1 };
			}
			return {
				pass: verdict === "PASS",
				reason: `simulated ${verdict.toLowerCase()}`,
				latencyMs: 1,
			};
		};
	}

	it("JG-EN-01: 3 PASS / 1 FAIL → ensemble PASS", async () => {
		const v = await runEnsemble(
			{
				judges: {
					a: fakeJudge("PASS"),
					b: fakeJudge("PASS"),
					c: fakeJudge("PASS"),
					d: fakeJudge("FAIL"),
				},
			},
			SAMPLE,
		);
		expect(v.pass).toBe(true);
		expect(v.validCount).toBe(4);
		expect(v.infraErrorCount).toBe(0);
		expect(v.unreliable).toBe(false);
	});

	it("JG-EN-02: 1 PASS / 3 FAIL → ensemble FAIL", async () => {
		const v = await runEnsemble(
			{
				judges: {
					a: fakeJudge("PASS"),
					b: fakeJudge("FAIL"),
					c: fakeJudge("FAIL"),
					d: fakeJudge("FAIL"),
				},
			},
			SAMPLE,
		);
		expect(v.pass).toBe(false);
		expect(v.validCount).toBe(4);
	});

	it("JG-EN-03: infra errors excluded from majority (2 PASS / 1 FAIL / 1 INFRA → PASS, validCount=3)", async () => {
		const v = await runEnsemble(
			{
				judges: {
					a: fakeJudge("PASS"),
					b: fakeJudge("PASS"),
					c: fakeJudge("FAIL"),
					d: fakeJudge("INFRA"),
				},
			},
			SAMPLE,
		);
		expect(v.pass).toBe(true);
		expect(v.validCount).toBe(3);
		expect(v.infraErrorCount).toBe(1);
		expect(isInfraError(v.perJudge.d!)).toBe(true);
	});

	it("JG-EN-04: all infra errors → unreliable=true, pass=false", async () => {
		const v = await runEnsemble(
			{
				judges: {
					a: fakeJudge("INFRA"),
					b: fakeJudge("INFRA"),
				},
			},
			SAMPLE,
		);
		expect(v.unreliable).toBe(true);
		expect(v.pass).toBe(false);
		expect(v.validCount).toBe(0);
		expect(v.infraErrorCount).toBe(2);
	});

	it("JG-EN-05: tie (1 PASS / 1 FAIL) → ensemble FAIL (no majority for pass)", async () => {
		const v = await runEnsemble(
			{
				judges: { a: fakeJudge("PASS"), b: fakeJudge("FAIL") },
			},
			SAMPLE,
		);
		expect(v.pass).toBe(false);
		expect(v.validCount).toBe(2);
		expect(v.unreliable).toBe(false);
	});

	it("JG-EN-06: thrown judge surfaces as infra error, not crash", async () => {
		const throwingJudge: Judge = async () => {
			throw new Error("simulated boom");
		};
		const v = await runEnsemble(
			{
				judges: { a: fakeJudge("PASS"), b: throwingJudge },
			},
			SAMPLE,
		);
		expect(v.validCount).toBe(1);
		expect(v.infraErrorCount).toBe(1);
		expect(isInfraError(v.perJudge.b!)).toBe(true);
	});
});
