// domain/provider-route — 순수 provider 라우팅 (old-naia-os factory.ts resolveProviderRoute 이식).
// config(provider/model/naiaKey) → 어느 transport route 로 보낼지 결정. 인스턴스화는 adapters/provider-resolver.
// 첫 흐름(provider 출처)은 lab-proxy / native / ollama 만. local-live(naia-omni)·claude-cli·nextain-error 는 후속.
import type { ProviderConfig } from "./chat.js";

export type ProviderRoute = "lab-proxy" | "ollama" | "native";

const LOCAL_PROVIDERS = new Set(["ollama", "vllm"]);

/**
 * naiaKey(로그인) 있고 명시적 로컬 provider 아니면 → lab-proxy(naia 게이트웨이 api.nextain.io).
 * ollama → ollama. 그 외(키 직접) → native(provider별 baseUrl).
 * (old resolveProviderRoute 의 첫-흐름 부분집합: claude-cli/local-live/nextain-error 는 후속 슬라이스)
 */
export function resolveProviderRoute(config: ProviderConfig): ProviderRoute {
	if (config.provider === "ollama") return "ollama";
	const naiaKey = config.naiaKey;
	if (naiaKey && !LOCAL_PROVIDERS.has(config.provider)) return "lab-proxy";
	return "native";
}

/** lab-proxy 게이트웨이 baseUrl(설정 override > 기본 prod). old lab-proxy.ts PROD_GATEWAY_URL. */
export function labProxyBaseUrl(config: ProviderConfig): string {
	return (config.labGatewayUrl?.replace(/\/+$/, "") || "https://api.nextain.io");
}

/**
 * native(키 직접) provider 별 OpenAI-compat baseUrl (old nextain-openai-adapter resolveBaseUrl 이식).
 * override(=labGatewayUrl/host) 우선. ollama/vllm 은 host/v1.
 */
export function nativeBaseUrl(provider: string, override?: string): string {
	const trimmed = override?.replace(/\/+$/, "");
	switch (provider) {
		case "openai":
			return trimmed || "https://api.openai.com/v1";
		case "xai":
			return trimmed || "https://api.x.ai/v1";
		case "glm":
		case "zai":
			return trimmed || "https://open.bigmodel.cn/api/paas/v4";
		case "gemini":
			// Google AI Studio OpenAI-compat 엔드포인트.
			return trimmed || "https://generativelanguage.googleapis.com/v1beta/openai";
		case "ollama":
			return `${trimmed || "http://localhost:11434"}/v1`;
		case "vllm":
			return `${trimmed || "http://localhost:8000"}/v1`;
		default:
			return trimmed || "https://api.openai.com/v1";
	}
}
