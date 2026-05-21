/**
 * Bench-purpose LLMClient — wraps GLM HTTP API to fit naia-agent's LLMClient
 * interface, so pi-prepare-step and hermes-prepare-step can be invoked during
 * fixture measurement without needing a full Anthropic/OpenAI host setup.
 *
 * GLM is chosen because:
 *   - cheap (glm-4.5-flash is the bench tier)
 *   - already used for the judge ensemble (env GLM_API_KEY is in scope)
 *   - HTTP only (no streaming SSE parse needed)
 *
 * This client is ONLY used by the benchmark harness for measurement. Not for
 * production. Production hosts inject their own LLMClient via HostContext.
 */

import type {
	LLMClient,
	LLMRequest,
	LLMResponse,
	LLMStreamChunk,
} from "@nextain/agent-core";

const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

export interface BenchLLMClientOptions {
	readonly apiKey?: string;
	readonly model?: string;
	readonly timeoutMs?: number;
}

/**
 * Build a minimal LLMClient that calls GLM's chat completions endpoint and
 * synthesizes a streaming chunk sequence from the (non-streaming) response.
 */
export function createBenchLLMClient(
	options: BenchLLMClientOptions = {},
): LLMClient {
	const apiKey = options.apiKey ?? process.env["GLM_API_KEY"];
	const model = options.model ?? process.env["GLM_MODEL"] ?? "glm-4.5-flash";
	const timeoutMs = options.timeoutMs ?? 60_000;
	if (!apiKey) {
		throw new Error(
			"createBenchLLMClient: GLM_API_KEY not set (env or options.apiKey)",
		);
	}

	async function callGlm(request: LLMRequest): Promise<string> {
		const messages = [
			...(request.system
				? [{ role: "system", content: stringifySystem(request.system) }]
				: []),
			...request.messages.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : llmMessageToText(m),
			})),
		];
		const body = {
			model,
			messages,
			temperature: request.temperature ?? 0,
			...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
		};
		const res = await fetch(GLM_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: request.signal ?? AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			throw new Error(`GLM HTTP ${res.status}: ${await res.text()}`);
		}
		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = data.choices?.[0]?.message?.content ?? "";
		return text;
	}

	return {
		generate: async (request: LLMRequest): Promise<LLMResponse> => {
			const text = await callGlm(request);
			return {
				id: `bench-${Date.now()}`,
				model,
				stopReason: "end_turn",
				usage: { inputTokens: 0, outputTokens: 0 },
				content: [{ type: "text", text }],
			} as LLMResponse;
		},
		stream: async function* (
			request: LLMRequest,
		): AsyncIterable<LLMStreamChunk> {
			const text = await callGlm(request);
			yield { type: "start", id: `bench-${Date.now()}`, model };
			yield {
				type: "content_block_start",
				index: 0,
				block: { type: "text", text: "" },
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			};
			yield { type: "content_block_stop", index: 0 };
			yield {
				type: "end",
				stopReason: "end_turn",
				usage: { inputTokens: 0, outputTokens: 0 },
			};
		},
	};
}

function stringifySystem(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) {
		return system
			.map((b) =>
				typeof b === "string" ? b : b && typeof b === "object" && "text" in b
					? String((b as { text: unknown }).text)
					: "",
			)
			.join("\n");
	}
	return "";
}

function llmMessageToText(m: { content: unknown }): string {
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.map((b) => {
				if (typeof b !== "object" || b === null) return "";
				const o = b as Record<string, unknown>;
				if (o["type"] === "text" && typeof o["text"] === "string") return o["text"];
				if (o["type"] === "thinking" && typeof o["thinking"] === "string") return `[thinking]\n${o["thinking"]}`;
				return "";
			})
			.join("\n");
	}
	return "";
}
