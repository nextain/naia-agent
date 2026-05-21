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
		"R7 Phase A.2 framing — criteria are written about a HYPOTHETICAL response.",
		"Simulate the answer mentally: if an agent had to answer the QUESTION using",
		"ONLY this CONTEXT, would the simulated answer satisfy the PASS CRITERION?",
		"You are NOT judging the context's wording — you are judging whether the",
		"CONTEXT supplies sufficient unambiguous information for the criterion's",
		"required answer.",
		"",
		"For abstention probes (where the criterion says the agent should refuse,",
		"say 'unknown', or not fabricate): PASS if the context lacks the asked",
		"information so an honest agent would abstain. FAIL if the context happens",
		"to include the asked fact (so an agent would not need to abstain) OR if",
		"the context is so confusing the agent might confabulate.",
		"",
		"Reply with EXACTLY ONE LINE:",
		"  PASS: <one-sentence reason — what fact(s) in context support the required answer>",
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
