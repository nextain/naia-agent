/**
 * Shared judge prompt — Slice 3-XR-Compact follow-up (#48).
 *
 * The same prompt template is sent to every judge so verdicts are
 * comparable. Returns a strict 1-line answer: "PASS: ..." or "FAIL: ...".
 * Reason text is short — judges that hallucinate longer prose force the
 * parser to strip surrounding noise.
 */

import type { JudgeInput, JudgeVerdict } from "./types.js";

export function buildJudgePrompt(input: JudgeInput): string {
	return [
		"You are an objective evaluator of an LLM agent's available context.",
		"",
		"The agent received the user's QUESTION below. To answer it, the agent",
		"only has access to the CONTEXT shown — that's the post-compaction window",
		"(recap + tail) OR the raw conversation OR whatever the compaction strategy",
		"under test produced.",
		"",
		"Your job: judge whether the CONTEXT contains enough faithful information",
		"to satisfy the PASS CRITERION. You are evaluating context quality, not the",
		"agent's response style.",
		"",
		"Reply with EXACTLY ONE LINE:",
		"  PASS: <one-sentence reason — what fact(s) in context satisfy the criterion>",
		"OR",
		"  FAIL: <one-sentence reason — what's missing, distorted, or fabricated>",
		"",
		"No prose before or after. No quotes.",
		"",
		`QUESTION: ${input.question}`,
		"",
		`CONTEXT: ${input.response}`,
		"",
		`PASS CRITERION: ${input.criterion}`,
	].join("\n");
}

/**
 * Parse a judge's free-text reply into a JudgeVerdict. Strict: leading line
 * must start with "PASS:" or "FAIL:" (case-insensitive after trim). If the
 * judge emits prose around it, the first matching line wins. Returns null
 * when no match — caller treats null as malformed.
 */
export function parseJudgeReply(
	text: string,
	latencyMs: number,
	approxTokens?: number,
): JudgeVerdict | null {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	for (const line of lines) {
		const m = /^(PASS|FAIL)\s*[:.\-]\s*(.+)$/i.exec(line);
		if (m) {
			const verdict = m[1]!.toUpperCase() === "PASS";
			const verdictBase: JudgeVerdict = {
				pass: verdict,
				reason: m[2]!.trim().slice(0, 300),
				latencyMs,
			};
			return approxTokens !== undefined
				? { ...verdictBase, approxTokens }
				: verdictBase;
		}
	}
	return null;
}
