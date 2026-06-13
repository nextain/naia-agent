// domain/provider-route — 순수 provider 라우팅 (old-naia-os factory.ts resolveProviderRoute 이식).
// config(provider/model/naiaKey) → 어느 transport route 로 보낼지 결정. 인스턴스화는 adapters/provider-resolver.
// 첫 흐름(provider 출처)은 lab-proxy / native / ollama 만. local-live(naia-omni)·claude-cli·nextain-error 는 후속.
import type { ProviderConfig } from "./chat.js";

export type ProviderRoute = "lab-proxy" | "ollama" | "native";

/**
 * **provider 타입**으로 라우팅(루크 정정 2026-06-12 — naiaKey 유무 아님):
 *  - `nextain`(naia 계정 타입, 우리 관할) → lab-proxy(any-llm 게이트웨이 api.nextain.io).
 *  - `ollama` → ollama(로컬).
 *  - 그 외(API-key 타입: gemini/glm/zai/openai/anthropic/xai/vllm) → native(외부 API·SDK **직결**, 게이트웨이 안 탐).
 *    ⚠️ API-key 타입은 naiaKey 가 있어도 직결 — 키체인에 naiaKey 남아있다고 lab-proxy 로 보내면 안 됨(그게 500 원인이었음).
 */
export function resolveProviderRoute(config: ProviderConfig): ProviderRoute {
	if (config.provider === "nextain") return "lab-proxy";
	if (config.provider === "ollama") return "ollama";
	return "native";
}

/** lab-proxy 게이트웨이 baseUrl(설정 override > 기본 prod) + `/v1`.
 *  ⚠️ openai-compat 가 `${base}/chat/completions` 로 POST → base 에 `/v1` 필수(old lab-proxy.ts 는 `/v1/chat/completions`).
 *  /v1 누락 시 api.nextain.io/chat/completions = 404(라이브 e2e 가 잡음). 이미 /vN 이면 중복 안 붙임. */
export function labProxyBaseUrl(config: ProviderConfig): string {
	const raw = config.labGatewayUrl?.replace(/\/+$/, "") || "https://api.nextain.io";
	return /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
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
			// z.ai coding plan (실측 200, Bearer). bigmodel.cn(Zhipu)은 잔액 0 → 429. 우리 GLM=z.ai coding.
			return trimmed || "https://api.z.ai/api/coding/paas/v4";
		case "gemini":
			// Google AI Studio OpenAI-compat 엔드포인트.
			return trimmed || "https://generativelanguage.googleapis.com/v1beta/openai";
		case "ollama":
			return `${trimmed || "http://localhost:11434"}/v1`;
		case "vllm":
			return `${trimmed || "http://localhost:8000"}/v1`;
		default:
			// ⚠️ 미등록 provider 를 조용히 openai 로 보내지 않음(provenance 리뷰 MEDIUM): override 있으면 커스텀 OpenAI-compat 허용,
			//    없으면 정직 에러. anthropic/claude = OpenAI-compat 아님(SDK 직결 별도 어댑터 = 후속 신규계약) → host override 없으면 여기서 차단.
			if (trimmed) return trimmed;
			throw new Error(`provider '${provider}' baseUrl 미정의 — OpenAI-compat 미지원(anthropic 등은 SDK 직결 신규계약 필요) 또는 host override 지정 필요`);
	}
}
