/**
 * Ensemble — majority of valid (non-infra-error) judges. Slice 3-XR-Compact #48.
 *
 * Infra errors (CLI missing, key missing, timeout, parse fail) are excluded
 * from the vote — they're surfaced separately. Tie → unreliable=false, but
 * caller should look at perJudge to understand. When validCount === 0, the
 * ensemble verdict is marked `unreliable=true` and `pass=false`.
 */

import type {
	EnsembleVerdict,
	Judge,
	JudgeInput,
	JudgeResult,
} from "./types.js";
import { isInfraError } from "./types.js";

export interface EnsembleSpec {
	readonly judges: Readonly<Record<string, Judge>>;
}

export async function runEnsemble(
	spec: EnsembleSpec,
	input: JudgeInput,
): Promise<EnsembleVerdict> {
	const names = Object.keys(spec.judges);
	const results = await Promise.all(
		names.map(async (name) => {
			try {
				const r = await spec.judges[name]!(input);
				return [name, r] as const;
			} catch (err) {
				return [
					name,
					{
						infraError: `unhandled: ${err instanceof Error ? err.message : String(err)}`,
						latencyMs: 0,
					} as JudgeResult,
				] as const;
			}
		}),
	);

	const perJudge: Record<string, JudgeResult> = {};
	let pass = 0;
	let fail = 0;
	let infra = 0;
	const reasons: string[] = [];
	for (const [name, r] of results) {
		perJudge[name] = r;
		if (isInfraError(r)) {
			infra++;
		} else {
			if (r.pass) pass++;
			else fail++;
			reasons.push(`${name}: ${r.pass ? "PASS" : "FAIL"} ${r.reason}`);
		}
	}
	const validCount = pass + fail;
	const unreliable = validCount === 0;
	const majority = pass > fail;

	return {
		pass: !unreliable && majority,
		reason: reasons.length > 0
			? reasons.join(" | ")
			: `unreliable: all ${infra} judges hit infra errors`,
		perJudge,
		validCount,
		infraErrorCount: infra,
		unreliable,
	};
}
