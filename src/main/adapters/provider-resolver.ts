// adapters/provider-resolver — 요청별 ProviderResolver. old buildProvider 의 헥사고날 이식.
// config(provider/model/naiaKey/apiKey) → route(domain) → 해당 transport 인스턴스.
//   lab-proxy : openai-compat(api.nextain.io, X-AnyLLM-Key: naiaKey)   — naia 로그인 시 cloud 라우팅
//   native    : openai-compat(provider별 baseUrl, Bearer: apiKey)
//   ollama    : makeOllamaProvider
// transport 자체는 stdio/gRPC 와 직교 — provider는 LLM 호출 어댑터일 뿐.
import type { ProviderConfig } from "../domain/chat.js";
import type { ProviderPort, ProviderResolverPort } from "../ports/uc1.js";
import { resolveProviderRoute, labProxyBaseUrl, nativeBaseUrl, anthropicBaseUrl, isLocalEngineBaseUrl } from "../domain/provider-route.js";
import { makeOpenAICompatProvider } from "./openai-compat-provider.js";
import { makeOllamaProvider } from "./ollama-provider.js";
import { makeAnthropicProvider } from "./anthropic-provider.js";
import { makeClaudeCodeProvider } from "./claude-code-provider.js";
import { makeCodexAppServerProvider, type CodexRunTurn } from "./codex-app-server-provider.js";

export interface ProviderResolverDeps {
	/** 테스트/대체용 fetch 주입(미주입 = global fetch). */
	fetch?: Parameters<typeof makeOpenAICompatProvider>[0]["fetch"];
	/** Codex app-server fake/alternate transport injection. */
	codexRunTurn?: CodexRunTurn;
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
					// anthropic — Messages API(/v1/messages, x-api-key, ANTHROPIC_API_KEY). OpenAI-compat 아님 → 전용 어댑터.
					return makeAnthropicProvider({
						baseUrl: anthropicBaseUrl(config),
						apiKey: config.apiKey ?? "",
						model: config.model,
						...(f ? { fetch: f } : {}),
					});
				case "claude-code":
					// claude-code-cli — Claude Agent SDK query(). 로컬 Claude Code 구독 인증 사용 → **apiKey/fetch 미주입**.
					//   (anthropic 처럼 키·게이트웨이 fetch 를 받지 않는다 — SDK 가 CLI 프로세스로 인증/전송.)
					return makeClaudeCodeProvider({ model: config.model });
				case "codex":
					// codex — 로컬 app-server/로그인 사용. OpenAI API key/fetch 경로와 완전히 분리.
					return makeCodexAppServerProvider({
						model: config.model,
						...(deps?.codexRunTurn ? { runTurn: deps.codexRunTurn } : {}),
					});
				case "lab-proxy": {
					// naia 게이트웨이 — OpenAI-compat /v1/chat/completions, auth=X-AnyLLM-Key: naiaKey.
					// UC-THINKING/FR-THINK-3: 게이트웨이 뒤에 어떤 모델이 있을지 모른다 → reasoning_effort 미지원(false).
					const baseUrl = labProxyBaseUrl(config);
					return makeOpenAICompatProvider({
						baseUrl,
						apiKey: config.naiaKey ?? "",
						auth: "x-anyllm",
						model: config.model,
						supportsReasoningEffort: false,
						...(f ? { fetch: f } : {}),
					});
				}
				default: {
					// native — provider별 baseUrl, Bearer: apiKey(creds_update).
					// host override: labGatewayUrl(범용) ?? vllmHost(vllm 전용). vllm 은 host 가 vllmHost 에 실리므로
					// 이걸 안 넘기면 커스텀 vllm endpoint 가 무시되고 localhost:8000 default 로 샌다(배선 갭).
					const baseUrl = nativeBaseUrl(config.provider, config.labGatewayUrl ?? config.vllmHost);
					return makeOpenAICompatProvider({
						baseUrl,
						apiKey: config.apiKey ?? "",
						model: config.model,
						// UC-THINKING/FR-THINK-2·3 — 로컬 엔진(loopback/사설망: ollama·vLLM)에만 reasoning_effort 허용.
						//   원격 클라우드(openai/gemini/glm/xai)에 보내면 비추론 모델에서 400.
						supportsReasoningEffort: isLocalEngineBaseUrl(baseUrl),
						...(f ? { fetch: f } : {}),
					});
				}
			}
		},
	};
}
