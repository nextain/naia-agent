// adapters/provider-resolver — 요청별 ProviderResolver. old buildProvider 의 헥사고날 이식.
// config(provider/model/naiaKey/apiKey) → route(domain) → 해당 transport 인스턴스.
//   lab-proxy : openai-compat(api.nextain.io, X-AnyLLM-Key: naiaKey)   — naia 로그인 시 cloud 라우팅
//   native    : openai-compat(provider별 baseUrl, Bearer: apiKey)
//   ollama    : makeOllamaProvider
// transport 자체는 stdio/gRPC 와 직교 — provider는 LLM 호출 어댑터일 뿐.
import type { ProviderConfig } from "../domain/chat.js";
import type { ProviderPort, ProviderResolverPort } from "../ports/uc1.js";
import { resolveProviderRoute, labProxyBaseUrl, nativeBaseUrl } from "../domain/provider-route.js";
import { makeOpenAICompatProvider } from "./openai-compat-provider.js";
import { makeOllamaProvider } from "./ollama-provider.js";

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
					return makeOllamaProvider();
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
					return makeOpenAICompatProvider({
						baseUrl: nativeBaseUrl(config.provider, config.labGatewayUrl),
						apiKey: config.apiKey ?? "",
						model: config.model,
						...(f ? { fetch: f } : {}),
					});
			}
		},
	};
}
