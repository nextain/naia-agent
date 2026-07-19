// adapters/sub-llm-provider — SubLlmPort 구현(Phase 3.2). sub-LLM first-class 표면.
// memoryLlmProvider(naia/vllm/ollama) → OpenAI-compat /chat/completions 비스트리밍 POST.
// memory 사실추출·compaction 과 동일 small-LLM 설정을 공유 — 배치(adk)·경량 작업용 first-class 호출 표면.
// 미구성(provider="none"/필수필드 누락) = undefined(호출처 폴백). fetch 주입(테스트·node fetch).
import type { SubLlmPort } from "../ports/sub-llm.js";
import type { MemoryLlmConfig } from "./naia-memory.js";
import { ensureCurrentProcessingAuthorized } from "./processing-operation-decorators.js";

export type SubLlmFetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** MemoryLlmConfig → SubLlmPort(또는 undefined=미구성). 순수·테스트 가능. 필수 누락 = undefined(fail-open, 호출처 폴백). */
export function buildSubLlmProvider(
	cfg: MemoryLlmConfig | undefined,
	deps: { fetch: SubLlmFetch },
): SubLlmPort | undefined {
	if (!cfg || cfg.provider === "none") return undefined;
	const provider = cfg.provider;
	const baseUrlRaw = cfg.baseUrl?.trim();
	const modelRaw = cfg.model?.trim();
	if (!baseUrlRaw || !modelRaw) return undefined; // 필수 누락 = 미구성(throw 아님 — 배치는 폴백 허용)
	const baseUrl = baseUrlRaw;
	const model = modelRaw;
	const apiKey = cfg.apiKey ?? "";
	const fetchFn = deps.fetch;
	let callSequence = 0;

	async function callOnce(
		messages: readonly { role: string; content: string }[],
		signal?: AbortSignal,
	): Promise<string> {
		const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
		await ensureCurrentProcessingAuthorized({
			operationKey: `sub_llm:call:${++callSequence}`,
			workload: "sub_llm",
			provider,
			model,
			endpointUrl: baseUrl,
			endpointZone: "unverified",
			requiresConsent: !/^https?:\/\/(?:localhost|127\.|\[?::1\]?)/i.test(baseUrl),
		});
		const res = await fetchFn(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model, messages, stream: false, temperature: 0 }),
			...(signal ? { signal } : {}),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`sub-llm(${provider}) HTTP ${res.status}: ${body.slice(0, 200)}`);
		}
		const text = await res.text();
		// OpenAI-compat 비스트리밍 응답: choices[0].message.content
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return text; // 비정형 응답 = 원문 반환(호출처가 판단)
		}
		const choices = (parsed as { choices?: ReadonlyArray<{ message?: { content?: string } }> })?.choices;
		const content = choices?.[0]?.message?.content;
		return typeof content === "string" ? content : "";
	}

	return {
		provider,
		model,
		async complete(prompt, opts) {
			const messages: { role: string; content: string }[] = [];
			if (opts?.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
			messages.push({ role: "user", content: prompt });
			return callOnce(messages, opts?.signal);
		},
		async completeMessages(messages, opts) {
			return callOnce(
				messages.map((m) => ({ role: m.role, content: m.content })),
				opts?.signal,
			);
		},
	};
}
