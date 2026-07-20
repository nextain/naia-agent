// domain/provider-route — 순수 provider 라우팅 (old-naia-os factory.ts resolveProviderRoute 이식).
// config(provider/model/naiaKey) → 어느 transport route 로 보낼지 결정. 인스턴스화는 adapters/provider-resolver.
// 첫 흐름(provider 출처)은 lab-proxy / native / ollama 만. local-live(naia-omni)·claude-cli·nextain-error 는 후속.
import type { ProviderConfig } from "./chat.js";

export type ProviderRoute = "lab-proxy" | "ollama" | "anthropic" | "claude-code" | "codex" | "native";

/**
 * **provider 타입**으로 라우팅(루크 정정 2026-06-12 — naiaKey 유무 아님):
 *  - `nextain`(naia 계정 타입, 우리 관할) → lab-proxy(any-llm 게이트웨이 api.nextain.io).
 *  - `ollama` → ollama(로컬).
 *  - `anthropic` → anthropic(Messages API /v1/messages, x-api-key, ANTHROPIC_API_KEY — 직접 키·per-token 과금).
 *  - `claude-code-cli` → claude-code(Claude Agent SDK query(), 로컬 Claude Code **구독 인증** 사용 — apiKey 없음, 과금 $0).
 *    ⚠️ anthropic 과 분리(루크 2026-06-17): claude-code-cli 를 Messages API 로 alias 하면 키 없으면 401·per-token 과금.
 *  - 그 외(OpenAI-compat API-key: gemini/glm/zai/openai/xai/vllm) → native(외부 API 직결, 게이트웨이 안 탐).
 *    ⚠️ API-key 타입은 naiaKey 가 있어도 직결 — 키체인에 naiaKey 남아있다고 lab-proxy 로 보내면 안 됨(그게 500 원인이었음).
 */
export function resolveProviderRoute(config: ProviderConfig): ProviderRoute {
	if (config.provider === "nextain") return "lab-proxy";
	if (config.provider === "ollama") return "ollama";
	if (config.provider === "claude-code-cli") return "claude-code"; // Agent SDK(구독 인증) — anthropic 보다 먼저 peel
	if (config.provider === "codex") return "codex"; // app-server(로컬 Codex 로그인) — OpenAI API-key route 와 분리
	if (config.provider === "anthropic") return "anthropic"; // Messages API(직접 키)
	return "native";
}

/**
 * UC-THINKING / FR-THINK-2 — baseUrl 이 **로컬 추론 엔진**(ollama·vLLM)인가(순수).
 *
 * 왜 필요한가: OpenAI-compat wire 에서 생각(thinking)을 끄는 유일한 스위치가 `reasoning_effort:"none"`
 * 인데(실측 2026-07-14: `think:false`·`chat_template_kwargs`·`/no_think` 전부 무시됨), 이 파라미터를
 * **비추론 원격 모델**(gpt-4o 등)에 보내면 **400** 이다. 그런데 naia-os 셸은 `enableThinking:false` 를
 * **기본값으로 항상 전송**한다 → 게이트가 없으면 클라우드 provider 가 전부 깨진다.
 *
 * 판별 기준 = **loopback/사설망**. 로컬 엔진은 미지원 파라미터를 조용히 무시하지만(ollama 0.32.0 실측),
 * 원격에 대해서는 "무시해 줄 것"이라 가정하지 않고 **보내지 않음으로써** 방어한다.
 * (naia-settings 문서의 "로컬 Ollama/vLLM = loopback/private baseUrl → 키 불요" 규칙과 같은 축.)
 *
 * 파싱 불가/비-http = false(보수적 — 모르면 안 보낸다).
 */
export function isLocalEngineBaseUrl(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false; // URL 로 못 읽으면 원격으로 간주(보수적)
	}
	if (host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
	if (host.endsWith(".local") || host.endsWith(".localhost")) return true;

	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a === 127) return true;                       // 127.0.0.0/8 loopback
	if (a === 10) return true;                        // 10.0.0.0/8      (RFC1918)
	if (a === 192 && b === 168) return true;          // 192.168.0.0/16  (RFC1918)
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12   (RFC1918)
	return false;
}

/** Anthropic Messages API baseUrl(host override > 기본). 어댑터가 `${base}/v1/messages` 로 POST. */
export function anthropicBaseUrl(config: ProviderConfig): string {
	return config.labGatewayUrl?.replace(/\/+$/, "") || "https://api.anthropic.com";
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
			// ⚠️ 미등록 provider 를 조용히 openai 로 보내지 않음: override 있으면 커스텀 OpenAI-compat 허용, 없으면 정직 에러.
			//    anthropic(Messages API)·claude-code-cli(Agent SDK)는 별 라우트로 빠지므로 여기 안 온다 — 여긴 진짜 미등록만.
			if (trimmed) return trimmed;
			throw new Error(`provider '${provider}' baseUrl 미정의 — OpenAI-compat 미지원(미등록 provider) 또는 host override 지정 필요`);
	}
}
