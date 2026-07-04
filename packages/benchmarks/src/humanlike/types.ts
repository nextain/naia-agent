/**
 * Human-like memory experience benchmark — scenario & trace types.
 *
 * Measures the product-owner definition of human-like memory (2026-07-04):
 *  (1) emotion-based association — surfacing an emotionally-connected past
 *      memory naturally when the topic shifts;
 *  (2) past-grounded preferences — applying tastes learned across sessions.
 * Explicitly NOT perfect recall: the target is *selective, appropriate*
 * recall. Hence every probe pairs a POSITIVE case (recall appropriate) with
 * the option of a NEGATIVE/control case (recall would be socially wrong) —
 * without the negative control the bench rewards a "creepy database" that
 * drags up old memories constantly (flagship cross-review consensus, Claude+GPT).
 *
 * This module is the credential-free deterministic core. The live runner
 * (agent=vertexai:gemini-3.5-flash + memory sub=vertexai:gemini-3.1-flash-lite,
 * via the any-llm gateway) produces a PipelineTrace per probe; this module
 * classifies it into the 5-bucket pipeline outcome so failures attribute
 * cleanly to the agent-loop vs the memory layer vs response style.
 */

export type ProbeFamily = "emotion-association" | "preference-application";

/** A probe is POSITIVE (recall SHOULD surface) or a NEGATIVE control
 *  (recall would be inappropriate — the agent should NOT force it). */
export type ProbePolarity = "positive" | "negative";

export interface HumanlikeProbe {
	readonly id: string;
	readonly family: ProbeFamily;
	readonly polarity: ProbePolarity;
	/** Session index + the user turn text that acts as the trigger. */
	readonly triggerSessionIndex: number;
	readonly triggerText: string;
	/** What semantic/emotional cue makes recall appropriate (positive) or
	 *  why it would be inappropriate (negative). Human-readable, judge-visible. */
	readonly triggerCondition: string;
	/** 1–2 acceptable prior memories (NOT one exact phrase). Deterministic
	 *  "target retrieved / used" is scored by any-of-set containment. */
	readonly expectedMemorySet: readonly string[];
	/** Factually-relevant but socially-inappropriate memories that must NOT be
	 *  surfaced (esp. for negative probes and to catch over-eager recall). */
	readonly forbiddenRecalls?: readonly string[];
	/** Acceptable style guidance for the judge (e.g. tentative, user-centered). */
	readonly acceptableStyle?: string;
}

export interface HumanlikeSession {
	readonly index: number;
	readonly label: string; // e.g. "Session A — 2026-04-15"
	readonly turns: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

export interface HumanlikeScenario {
	readonly id: string;
	readonly family: ProbeFamily;
	readonly notes: string;
	/** seed sessions + at least one distractor session before probes. */
	readonly sessions: readonly HumanlikeSession[];
	readonly probes: readonly HumanlikeProbe[];
}

/**
 * What the live loop observed for one probe. All three booleans are
 * DETERMINISTIC (no judge): from the recall-marker log + retrieved-context
 * inspection + response-text containment against `expectedMemorySet`.
 */
export interface PipelineTrace {
	readonly probeId: string;
	/** Agent emitted a `<recall>…</recall>` marker on/around the trigger turn. */
	readonly recallAttempted: boolean;
	/** Retrieved context contained a member of expectedMemorySet. */
	readonly targetRetrieved: boolean;
	/** The final user-facing response used a member of expectedMemorySet. */
	readonly targetUsed: boolean;
	/** The final response surfaced a forbiddenRecall (over-eager / inappropriate). */
	readonly forbiddenSurfaced?: boolean;
	/** Raw final response text (for the judge layer). */
	readonly responseText?: string;
}

/** 5-bucket pipeline outcome — clean attribution across the two repos. */
export type PipelineBucket =
	| "no-recall-attempt" // agent-loop recall-DECISION failure (not memory!)
	| "retrieval-miss" // memory-layer failure (queried, target not returned)
	| "not-used" // agent-integration failure (returned, response ignored it)
	| "used-needs-judge" // target used — social quality decided by judge layer
	| "abstained-correctly" // negative probe: agent correctly did NOT force recall
	| "forced-inappropriate"; // negative probe: agent dragged memory in (creepy)

export interface PipelineOutcome {
	readonly probeId: string;
	readonly bucket: PipelineBucket;
	/** Deterministic verdict where decidable; null when the judge layer must
	 *  decide (used-needs-judge). */
	readonly deterministicPass: boolean | null;
	/** Which layer a failure attributes to (null on pass / needs-judge). */
	readonly failureLayer: "agent-decision" | "memory-retrieval" | "agent-integration" | null;
}
