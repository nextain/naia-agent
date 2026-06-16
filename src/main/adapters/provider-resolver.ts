// adapters/provider-resolver — 요청별 ProviderResolver. old buildProvider 의 헥사고날 이식.
// config(provider/model/naiaKey/apiKey) → route(domain) → 해당 transport 인스턴스.
//   lab-proxy : openai-compat(api.nextain.io, X-AnyLLM-Key: naiaKey)   — naia 로그인 시 cloud 라우팅
//   native    : openai-compat(provider별 baseUrl, Bearer: apiKey)
//   ollama    : makeOllamaProvider
// transport 자체는 stdio/gRPC 와 직교 — provider는 LLM 호출 어댑터일 뿐.
import type { ProviderConfig } from "../domain/chat.js";
import type { ProviderPort, ProviderResolverPort } from "../ports/uc1.js";
import { resolveProviderRoute, labProxyBaseUrl, nativeBaseUrl, anthropicBaseUrl } from "../domain/provider-route.js";
import { makeOpenAICompatProvider } from "./openai-compat-provider.js";
import { makeOllamaProvider } from "./ollama-provider.js";
import { makeAnthropicProvider } from "./anthropic-provider.js";

export interface ProviderResolverDeps {
	/** 테스트/대체용 fetch 주입(미주입 = global fetch). */
	fetch?: Parameters<typeof makeOpenAICompatProvider>[0]["fetch"];
}

export function makeProviderResolver(deps?: ProviderResolverDeps): ProviderResolverPort {
	const f = deps?.fetch;
	return {
		resolve(config: ProviderConfig): ProviderPort {
			switch (resolveProviderRoute(config)) {
				case "ollama":
					// fetch 주입 전달(미주입=global). 안 넘기면 헤드리스 테스트가 ollama 를 mock 못 해 실 네트워크로 샘(직교 위반).
					return makeOllamaProvider(f ? { fetch: f } : undefined);
				case "anthropic":
					// anthropic·claude-code-cli — Messages API(/v1/messages, x-api-key). OpenAI-compat 아님 → 전용 어댑터.
					return makeAnthropicProvider({
						baseUrl: anthropicBaseUrl(config),
						apiKey: config.apiKey ?? "",
						model: config.model,
						...(f ? { fetch: f } : {}),
					});
				case "lab-proxy":
					// naia 게이트웨이 — OpenAI-compat /v1/chat/completions, auth=X-AnyLLM-Key: naiaKey.
					return makeOpenAICompatProvider({
						baseUrl: labProxyBaseUrl(config),
						apiKey: config.naiaKey ?? "",
						auth: "x-anyllm",
						model: config.model,
						...(f ? { fetch: f } : {}),
					});
				default:
					// native — provider별 baseUrl, Bearer: apiKey(creds_update).
					// host override: labGatewayUrl(범용) ?? vllmHost(vllm 전용). vllm 은 host 가 vllmHost 에 실리므로
					// 이걸 안 넘기면 커스텀 vllm endpoint 가 무시되고 localhost:8000 default 로 샌다(배선 갭).
					return makeOpenAICompatProvider({
						baseUrl: nativeBaseUrl(config.provider, config.labGatewayUrl ?? config.vllmHost),
						apiKey: config.apiKey ?? "",
						model: config.model,
						...(f ? { fetch: f } : {}),
					});
			}
		},
	};
}
