/**
 * GLM coding plan judge — Slice 3-XR-Compact follow-up (#48).
 *
 * Uses GLM_API_KEY from process.env (loaded from ~/.naia-agent/.env via the
 * bin's loadEnvAndConfig in production; the runner exports the var before
 * calling). Direct HTTPS call to zhipu's OpenAI-compatible endpoint — no
 * CLI subprocess, so no TTY / sandbox surprises.
 */

import { performance } from "node:perf_hooks";
import type { Judge, JudgeInput, JudgeResult } from "./types.js";
import { buildJudgePrompt, parseJudgeReply } from "./prompt.js";

const GLM_DEFAULT_MODEL = "glm-4.5-flash";
const GLM_DEFAULT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

export const glmJudge: Judge = async (
	input: JudgeInput,
): Promise<JudgeResult> => {
	const t0 = performance.now();
	const apiKey = process.env.GLM_API_KEY;
	if (!apiKey) {
		return {
			infraError: "GLM_API_KEY not set in process.env",
			latencyMs: performance.now() - t0,
		};
	}
	const model = process.env.GLM_MODEL ?? GLM_DEFAULT_MODEL;
	const endpoint = process.env.GLM_ENDPOINT ?? GLM_DEFAULT_ENDPOINT;
	const timeoutMs = input.timeoutMs ?? 30_000;
	const prompt = buildJudgePrompt(input);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0,
				max_tokens: 200,
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			return {
				infraError: `GLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
				latencyMs: performance.now() - t0,
			};
		}
		const body = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: { total_tokens?: number };
		};
		const content = body.choices?.[0]?.message?.content ?? "";
		const verdict = parseJudgeReply(
			content,
			performance.now() - t0,
			body.usage?.total_tokens,
		);
		if (!verdict) {
			return {
				infraError: `GLM reply unparseable: ${content.slice(0, 200)}`,
				latencyMs: performance.now() - t0,
			};
		}
		return verdict;
	} catch (err) {
		clearTimeout(timer);
		return {
			infraError: `GLM fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			latencyMs: performance.now() - t0,
		};
	}
};
