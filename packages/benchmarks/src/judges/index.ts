/**
 * LLM-judge ensemble — Slice 3-XR-Compact follow-up (#48).
 *
 * Public exports for the judges harness. The runner picks `defaultEnsemble`
 * which mirrors the user-directed 4-judge panel (GLM coding plan + opencode
 * + codex + gemini). Tests / smoke scripts can import individual judges to
 * exercise one provider at a time without the others' env requirements.
 */

export type {
	EnsembleVerdict,
	Judge,
	JudgeInfraError,
	JudgeInput,
	JudgeResult,
	JudgeVerdict,
} from "./types.js";
export { isInfraError } from "./types.js";
export { buildJudgePrompt, parseJudgeReply } from "./prompt.js";
export { glmJudge } from "./glm-judge.js";
export { codexJudge, geminiJudge, opencodeJudge } from "./cli-judge.js";
export type { EnsembleSpec } from "./ensemble.js";
export { runEnsemble } from "./ensemble.js";

import type { Judge } from "./types.js";
import { glmJudge } from "./glm-judge.js";
import { codexJudge, geminiJudge, opencodeJudge } from "./cli-judge.js";

/**
 * User-directed 4-judge panel (#48): GLM coding plan (HTTP) + opencode +
 * codex + gemini CLIs. Use with `runEnsemble({ judges: defaultEnsemble }, ...)`.
 */
export const defaultEnsemble: Readonly<Record<string, Judge>> = {
	glm: glmJudge,
	opencode: opencodeJudge,
	codex: codexJudge,
	gemini: geminiJudge,
};
