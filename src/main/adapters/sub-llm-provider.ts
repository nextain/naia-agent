// adapters/sub-llm-provider — SubLlmPort 구현(Phase 3.2). sub-LLM first-class 표면.
// memoryLlmProvider(naia/vllm/ollama) → OpenAI-compat /chat/completions 비스트리밍 POST.
// memory 사실추출·compaction 과 동일 small-LLM 설정을 공유 — 배치(adk)·경량 작업용 first-class 호출 표면.
// 미구성(provider="none"/필수필드 누락) = undefined(호출처 폴백). fetch 주입(테스트·node fetch).
import { isLocalEngineBaseUrl } from "../domain/provider-route.js";
import type { SubLlmCallOptions, SubLlmPort } from "../ports/sub-llm.js";
export interface SubLlmConfig {
	readonly provider: string;
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly model?: string;
	readonly auth?: "bearer" | "x-anyllm";
	readonly thinkingLevel?: string;
}

export type SubLlmFetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Retry a failed cloud sub request at most once with the main role. Authorization
 * is re-evaluated by each provider for its own destination. */
export function withMainFallback(
	sub: SubLlmPort,
	main: SubLlmPort,
	log: (event: { provider: string; model?: string; reason: string; attemptRole?: "memory" | "main" }) => void,
): SubLlmPort {
	const run = async (invoke: (port: SubLlmPort) => Promise<string>) => {
		try {
			const result = await invoke(sub);
			if (!result.trim()) throw new Error("SUB_LLM_INVALID_RESPONSE");
			log({ provider: sub.provider, model: sub.model, reason: "success", ...(sub.role ? { attemptRole: sub.role } : {}) });
			return result;
		} catch (original) {
			const status = original && typeof original === "object" && "status" in original ? (original as { status: unknown }).status : undefined;
			const reason = typeof status === "number" ? `http_${status}` : original instanceof Error && original.message === "SUB_LLM_INVALID_RESPONSE" ? "invalid_response" : original instanceof Error && original.message === "SUB_LLM_PROCESSING_NOT_AUTHORIZED" ? "authorization_denied" : "request_failed";
			log({ provider: sub.provider, model: sub.model, reason, ...(sub.role ? { attemptRole: sub.role } : {}) });
			if ((original instanceof Error && original.message === "SUB_LLM_PROCESSING_NOT_AUTHORIZED") ||
				(sub.local || ["ollama", "vllm"].includes(sub.provider.toLowerCase())) ||
				(sub.provider === main.provider && sub.model === main.model && sub.endpoint === main.endpoint)) throw original;
			try {
				const result = await invoke(main);
				if (!result.trim()) throw new Error("SUB_LLM_INVALID_RESPONSE");
				log({ provider: main.provider, model: main.model, reason: "fallback_success", ...(main.role ? { attemptRole: main.role } : {}) });
				return result;
			} catch {
				log({ provider: main.provider, model: main.model, reason: "fallback_failed", ...(main.role ? { attemptRole: main.role } : {}) });
				throw original;
			}
		}
	};
	return {
		provider: sub.provider,
		model: sub.model,
		complete: (prompt, opts) => run((port) => {
			if (opts?.signal?.aborted) return Promise.reject(new Error("SUB_LLM_ABORTED"));
			return port.complete(prompt, opts);
		}),
		completeMessages: (messages, opts) => run((port) => {
			if (opts?.signal?.aborted) return Promise.reject(new Error("SUB_LLM_ABORTED"));
			return port.completeMessages(messages, opts);
		}),
	};
}

/** 독립 SubLlmConfig → SubLlmPort(또는 undefined=미구성). memory 설정 타입에 의존하지 않는다. */
export function buildSubLlmProvider(
	cfg: SubLlmConfig | undefined,
	deps: {
		fetch: SubLlmFetch;
		temperature?: number | null;
		maxTokens?: number;
		strictResponse?: boolean;
	},
): SubLlmPort | undefined {
	if (!cfg || cfg.provider === "none") return undefined;
	const provider = cfg.provider;
	const baseUrlRaw = cfg.baseUrl?.trim();
	const modelRaw = cfg.model?.trim();
	if (!baseUrlRaw || !modelRaw) return undefined; // 필수 누락 = 미구성(throw 아님 — 배치는 폴백 허용)
	const baseUrl = baseUrlRaw;
	const model = modelRaw;
	const apiKey = cfg.apiKey ?? "";
	const auth = cfg.auth ?? "bearer";
	const thinkingLevel = cfg.thinkingLevel;
	const fetchFn = deps.fetch;
	const temperature = deps.temperature === null ? undefined : (deps.temperature ?? 0);

	async function callOnce(
		messages: readonly { role: string; content: string }[],
		signal?: AbortSignal,
		authorizeAndDisclose?: SubLlmCallOptions["authorizeAndDisclose"],
	): Promise<string> {
		const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
		if (signal?.aborted) throw new Error("SUB_LLM_ABORTED");
		if (!authorizeAndDisclose || !await authorizeAndDisclose({
			workload: "sub_llm",
			provider,
			model,
			endpoint: baseUrl,
            ...(signal ? { signal } : {}),
		})) {
			throw new Error("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
		}
		if (signal?.aborted) throw new Error("SUB_LLM_ABORTED");
		const res = await fetchFn(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey
					? auth === "x-anyllm"
						? { "X-AnyLLM-Key": `Bearer ${apiKey}` }
						: { authorization: `Bearer ${apiKey}` }
					: {}),
			},
			body: JSON.stringify({
				model,
				messages,
				stream: false,
				...((provider === "naia" || provider === "nextain") && (thinkingLevel === "low" || thinkingLevel === "high" || thinkingLevel === "xhigh")
                  ? { reasoning_effort: thinkingLevel }
                  : isLocalEngineBaseUrl(baseUrl) && thinkingLevel === "off" ? { reasoning_effort: "none" } : {}),
				...(temperature !== undefined ? { temperature } : {}),
				...(typeof deps.maxTokens === "number" && Number.isInteger(deps.maxTokens) && deps.maxTokens > 0
					? { max_tokens: deps.maxTokens }
					: {}),
			}),
			...(signal ? { signal } : {}),
		});
		if (!res.ok) {
			const body = deps.strictResponse ? "" : await res.text().catch(() => "");
			throw Object.assign(new Error(`sub-llm(${provider}) HTTP ${res.status}: ${body.slice(0, 200)}`), {
				status: res.status,
			});
		}
		const text = await res.text();
		// OpenAI-compat 비스트리밍 응답: choices[0].message.content
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			if (deps.strictResponse) throw new Error("SUB_LLM_INVALID_RESPONSE");
			return text; // 비정형 응답 = 원문 반환(호출처가 판단)
		}
		const choices = (parsed as { choices?: ReadonlyArray<{ message?: { content?: string } }> })?.choices;
		const content = choices?.[0]?.message?.content;
		return typeof content === "string" ? content : "";
	}

	return {
		provider,
		model,
		local: isLocalEngineBaseUrl(baseUrl),
        endpoint: baseUrl.replace(/\/+$/, ""),
		async complete(prompt, opts) {
			const messages: { role: string; content: string }[] = [];
			if (opts?.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
			messages.push({ role: "user", content: prompt });
			return callOnce(messages, opts?.signal, opts?.authorizeAndDisclose);
		},
		async completeMessages(messages, opts) {
			return callOnce(
				messages.map((m) => ({ role: m.role, content: m.content })),
				opts?.signal,
				opts?.authorizeAndDisclose,
			);
		},
	};
}
