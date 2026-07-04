/**
 * Human-like memory bench — social-quality judge layer (Slice HL-2).
 *
 * The deterministic pipeline classifies a positive probe as `used-needs-judge`
 * once the recalled memory is actually USED in the response. Whether that use
 * was human-like is a graded, social judgment — deferred to a FLAGSHIP ensemble
 * (design: Claude + GPT-5.5, 2026-07-04). Each judge scores three axes 0–3:
 *   - appropriateness (적절성): right memory, right moment — not forced/creepy;
 *   - naturalness (자연스러움): woven in naturally vs a mechanical "you said X";
 *   - faithfulness (충실성): accurate to what the user actually shared, no
 *     fabrication or distortion.
 * Per-axis MEDIAN across judges (robust to one outlier); overall = mean of the
 * three axis-medians; pass at overall ≥ SOCIAL_QUALITY_PASS_THRESHOLD.
 *
 * Gemini is the SUT (system under test), so it is NOT a judge here — same-family
 * bias. The panel is codex (GPT) + claude. Real CLI calls are gated by the
 * runner (NAIA_JUDGE_ENSEMBLE=1) to protect credits; this module is pure except
 * `makeScoredCliJudge`, which reuses the judges/ CLI spawn primitive.
 */
import { performance } from "node:perf_hooks";
import { CLI_SPECS, runCli, type CliSpec } from "../judges/cli-judge.js";
import type { JudgeInfraError } from "../judges/types.js";

/** Local narrowing over ScoredJudgeResult (types/ isInfraError is typed for the
 *  binary JudgeResult union, which SocialQualityVerdict is not part of). */
function isInfraError(r: ScoredJudgeResult): r is JudgeInfraError {
	return "infraError" in r;
}

export interface SocialQualityAxes {
	/** 0–3: was surfacing this memory appropriate for THIS moment? */
	readonly appropriateness: number;
	/** 0–3: naturally woven in vs mechanical / presumptuous? */
	readonly naturalness: number;
	/** 0–3: accurate to what the user actually shared (no fabrication)? */
	readonly faithfulness: number;
}

export interface SocialQualityVerdict {
	readonly axes: SocialQualityAxes;
	readonly reason: string;
	readonly latencyMs: number;
}

export type ScoredJudgeResult = SocialQualityVerdict | JudgeInfraError;

export interface SocialQualityInput {
	/** The user turn that triggered recall. */
	readonly trigger: string;
	/** naia's final response we are judging. */
	readonly response: string;
	/** The past memory naia was expected to reflect (scenario anchor). */
	readonly expectedMemory: readonly string[];
	/** What the memory layer ACTUALLY returned for this probe. Faithfulness is
	 *  judged against THIS (the agent is isolated to marker-driven recall, so
	 *  anything in the response beyond these facts is fabrication). Omit → the
	 *  judge falls back to expectedMemory for faithfulness. */
	readonly recalledMemory?: readonly string[];
	/** Acceptable style guidance for this probe (from the scenario). */
	readonly acceptableStyle?: string;
	/** Memories that would be socially inappropriate to surface here. */
	readonly forbiddenRecalls?: readonly string[];
	readonly timeoutMs?: number;
}

/** A judge that scores social quality (not the binary judges/ Judge). */
export type ScoredJudge = (input: SocialQualityInput) => Promise<ScoredJudgeResult>;

export const SOCIAL_QUALITY_PASS_THRESHOLD = 2.0;

// ── pure: prompt / parse / aggregate ──────────────────────────────────────

export function buildSocialQualityPrompt(input: SocialQualityInput): string {
	const lines = [
		"You are one of several FLAGSHIP judges rating how human-like an AI's use of",
		"a recalled long-term memory is. Human-like memory is SELECTIVE and",
		"appropriate — not perfect recall, and never a creepy database that drags up",
		"old facts. Judge ONLY the social quality of the memory use below.",
		"",
		"Rate three axes, each an integer 0–3 (0=very poor, 1=poor, 2=good, 3=excellent):",
		"  APPROPRIATENESS — was surfacing this memory right for THIS moment (not forced/creepy)?",
		"  NATURALNESS — woven in naturally, vs a mechanical 'you told me X' or presumptuous tone?",
		"  FAITHFULNESS — does the response stay true to the RECALLED MEMORY below, inventing no",
		"                 extra specifics the memory does not support?",
		"",
		"Reply with EXACTLY these four lines and nothing else:",
		"APPROPRIATENESS: <0-3>",
		"NATURALNESS: <0-3>",
		"FAITHFULNESS: <0-3>",
		"REASON: <one short sentence>",
		"",
		`USER TURN (trigger): ${input.trigger}`,
		"",
		`AI RESPONSE (judge this): ${input.response}`,
		"",
		`MEMORY THE AI SHOULD REFLECT: ${input.expectedMemory.join(" / ")}`,
	];
	const recalled = input.recalledMemory && input.recalledMemory.length > 0 ? input.recalledMemory : input.expectedMemory;
	lines.push("", `RECALLED MEMORY the AI actually had (judge FAITHFULNESS against this): ${recalled.join(" | ")}`);
	if (input.acceptableStyle) lines.push("", `ACCEPTABLE STYLE: ${input.acceptableStyle}`);
	if (input.forbiddenRecalls && input.forbiddenRecalls.length > 0) {
		lines.push("", `WOULD BE INAPPROPRIATE TO SURFACE: ${input.forbiddenRecalls.join(", ")}`);
	}
	return lines.join("\n");
}

const AXIS_PATTERNS: ReadonlyArray<readonly [keyof SocialQualityAxes, RegExp]> = [
	["appropriateness", /APPROPRIATENESS\s*[:=]\s*([0-3])/i],
	["naturalness", /NATURALNESS\s*[:=]\s*([0-3])/i],
	["faithfulness", /FAITHFULNESS\s*[:=]\s*([0-3])/i],
];

/** Parse a scored reply. All three axes required (0–3) or null (malformed). */
export function parseSocialQualityReply(text: string, latencyMs: number): SocialQualityVerdict | null {
	const scores: Record<keyof SocialQualityAxes, number> = { appropriateness: -1, naturalness: -1, faithfulness: -1 };
	for (const [key, pat] of AXIS_PATTERNS) {
		const m = pat.exec(text);
		if (!m) return null;
		scores[key] = Number(m[1]);
	}
	const reasonMatch = /REASON\s*[:=]\s*(.+)/i.exec(text);
	return {
		axes: { appropriateness: scores.appropriateness, naturalness: scores.naturalness, faithfulness: scores.faithfulness },
		reason: (reasonMatch?.[1] ?? "").trim().slice(0, 300),
		latencyMs,
	};
}

/** Median of a non-empty number list (mean of the two middles when even). */
export function median(nums: readonly number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function medianAxes(verdicts: readonly SocialQualityVerdict[]): SocialQualityAxes {
	return {
		appropriateness: median(verdicts.map((v) => v.axes.appropriateness)),
		naturalness: median(verdicts.map((v) => v.axes.naturalness)),
		faithfulness: median(verdicts.map((v) => v.axes.faithfulness)),
	};
}

export interface SocialQualityAggregate {
	/** Per-axis median across valid judges. */
	readonly axes: SocialQualityAxes;
	/** Mean of the three axis-medians (0–3). */
	readonly overall: number;
	readonly pass: boolean;
	readonly perJudge: Readonly<Record<string, ScoredJudgeResult>>;
	readonly validCount: number;
	readonly infraErrorCount: number;
	/** validCount === 0 → no judge scored; verdict unreliable, pass=false. */
	readonly unreliable: boolean;
	readonly reason: string;
}

export function aggregateSocialQuality(
	perJudge: Readonly<Record<string, ScoredJudgeResult>>,
): SocialQualityAggregate {
	const valid: SocialQualityVerdict[] = [];
	let infra = 0;
	const reasons: string[] = [];
	for (const [name, r] of Object.entries(perJudge)) {
		if (isInfraError(r)) {
			infra++;
		} else {
			valid.push(r);
			const a = r.axes;
			reasons.push(`${name}: a${a.appropriateness}/n${a.naturalness}/f${a.faithfulness} ${r.reason}`);
		}
	}
	if (valid.length === 0) {
		return {
			axes: { appropriateness: 0, naturalness: 0, faithfulness: 0 },
			overall: 0,
			pass: false,
			perJudge,
			validCount: 0,
			infraErrorCount: infra,
			unreliable: true,
			reason: `unreliable: all ${infra} judges hit infra errors`,
		};
	}
	const axes = medianAxes(valid);
	const overall = (axes.appropriateness + axes.naturalness + axes.faithfulness) / 3;
	return {
		axes,
		overall,
		pass: overall >= SOCIAL_QUALITY_PASS_THRESHOLD,
		perJudge,
		validCount: valid.length,
		infraErrorCount: infra,
		unreliable: false,
		reason: reasons.join(" | "),
	};
}

// ── CLI-backed scored judges (reuse judges/ spawn primitive) ──────────────

function makeScoredCliJudge(spec: CliSpec): ScoredJudge {
	return async (input: SocialQualityInput): Promise<ScoredJudgeResult> => {
		const t0 = performance.now();
		const timeoutMs = input.timeoutMs ?? 90_000;
		try {
			const result = await runCli(spec, buildSocialQualityPrompt(input), timeoutMs);
			const latencyMs = performance.now() - t0;
			if (result.timedOut) return { infraError: `${spec.name} timed out after ${timeoutMs}ms`, latencyMs };
			if (result.exitCode !== 0) {
				return { infraError: `${spec.name} exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-200)}`, latencyMs };
			}
			const cleaned = result.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
			const verdict = parseSocialQualityReply(cleaned, latencyMs);
			if (!verdict) return { infraError: `${spec.name} reply unparseable: ${cleaned.slice(-200)}`, latencyMs };
			return verdict;
		} catch (err) {
			return { infraError: `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`, latencyMs: performance.now() - t0 };
		}
	};
}

/** Flagship panel: codex (GPT) + claude. Gemini excluded — it is the SUT. */
export const defaultSocialQualityJudges: Readonly<Record<string, ScoredJudge>> = {
	codex: makeScoredCliJudge(CLI_SPECS.codex),
	claude: makeScoredCliJudge(CLI_SPECS.claude),
};

/** Run the scored panel over one probe and aggregate (per-axis median). */
export async function judgeSocialQuality(
	input: SocialQualityInput,
	judges: Readonly<Record<string, ScoredJudge>> = defaultSocialQualityJudges,
): Promise<SocialQualityAggregate> {
	const names = Object.keys(judges);
	const results = await Promise.all(
		names.map(async (name) => {
			try {
				return [name, await judges[name]!(input)] as const;
			} catch (err) {
				return [name, { infraError: `unhandled: ${err instanceof Error ? err.message : String(err)}`, latencyMs: 0 } as ScoredJudgeResult] as const;
			}
		}),
	);
	const perJudge: Record<string, ScoredJudgeResult> = {};
	for (const [name, r] of results) perJudge[name] = r;
	return aggregateSocialQuality(perJudge);
}
