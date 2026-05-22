/**
 * Bench-purpose LLMClient — wraps Gemini HTTP API to fit naia-agent's LLMClient
 * interface, so pi-prepare-step and hermes-prepare-step can be invoked during
 * fixture measurement.
 *
 * Gemini 2.5 Flash is chosen because:
 *   - 1M token context (handles 250K+ char fixtures)
 *   - already used for the judge ensemble (env GEMINI_API_KEY is in scope)
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

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface BenchLLMClientOptions {
	readonly apiKey?: string;
	readonly model?: string;
	readonly timeoutMs?: number;
}

export interface BenchLLMClient extends LLMClient {
	totalInputTokens: number;
	totalOutputTokens: number;
}

export function createBenchLLMClient(
	options: BenchLLMClientOptions = {},
): BenchLLMClient {
	const apiKey = options.apiKey ?? process.env["GEMINI_API_KEY"];
	const model = options.model ?? process.env["GEMINI_MODEL"] ?? "gemini-2.5-flash";
	const timeoutMs = options.timeoutMs ?? 120_000;
	if (!apiKey) {
		throw new Error(
			"createBenchLLMClient: GEMINI_API_KEY not set (env or options.apiKey)",
		);
	}

	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	async function callGemini(request: LLMRequest): Promise<{ text: string; inTok: number; outTok: number }> {
		const systemParts: { text: string }[] = [];
		if (request.system) {
			const sysText = stringifySystem(request.system);
			if (sysText) systemParts.push({ text: sysText });
		}
		const contents = request.messages.map((m) => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: typeof m.content === "string" ? m.content : llmMessageToText(m) }],
		}));

		const body: Record<string, unknown> = {
			contents,
			generationConfig: {
				temperature: request.temperature ?? 0,
				...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
			},
		};
		if (systemParts.length > 0) {
			body.systemInstruction = { parts: systemParts };
		}

		const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: request.signal ?? AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
		}
		const data = (await res.json()) as {
			candidates?: { content?: { parts?: { text?: string }[] } }[];
			usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
		};
		const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
		const inTok = data.usageMetadata?.promptTokenCount ?? 0;
		const outTok = data.usageMetadata?.candidatesTokenCount ?? 0;
		return { text, inTok, outTok };
	}

	function trackUsage(inTok: number, outTok: number) {
		totalInputTokens += inTok;
		totalOutputTokens += outTok;
	}

	return {
		get totalInputTokens() { return totalInputTokens; },
		get totalOutputTokens() { return totalOutputTokens; },
		generate: async (request: LLMRequest): Promise<LLMResponse> => {
			const { text, inTok, outTok } = await callGemini(request);
			trackUsage(inTok, outTok);
			return {
				id: `bench-${Date.now()}`,
				model,
				stopReason: "end_turn",
				usage: { inputTokens: inTok, outputTokens: outTok },
				content: [{ type: "text", text }],
			} as LLMResponse;
		},
		stream: async function* (
			request: LLMRequest,
		): AsyncIterable<LLMStreamChunk> {
			const { text, inTok, outTok } = await callGemini(request);
			trackUsage(inTok, outTok);
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
				usage: { inputTokens: inTok, outputTokens: outTok },
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
