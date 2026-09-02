// domain/cost — per-million-token 가격표 + cost 계산 (old-naia-os/agent/src/providers/cost.ts verbatim 이식).
// 순수 함수. model 미등록 = 0(크래시 아님 — 셸 formatCost 가 0 도 안전 렌더).
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	// Gemini 3.x (2026-08 공식가 — 3.7/3.6 flash 는 2026 인트로가, 2027-01 부터 1.5/7.5 예정)
	"gemini-3.7-flash": { input: 0.75, output: 3.75 },
	"gemini-3.6-flash": { input: 0.75, output: 3.75 },
	"gemini-3.5-flash": { input: 1.5, output: 9.0 },
	"gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
	"gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
	"gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
	// Gemini 2.5 (레거시 현행 — 2.0 계열은 2026-06-01 shutdown 으로 제거)
	"gemini-2.5-flash": { input: 0.3, output: 2.5 },
	"gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
	"gemini-2.5-pro": { input: 1.25, output: 10.0 },
	// xAI (2026-08 라인업 — grok-4.x/3.x 구모델은 2026-05-15 retire, 슬러그는 grok-4.3 으로 리다이렉트되므로
	//  잔존 저장 설정도 grok-4.3 단가로 수렴. 200k 초과 컨텍스트 할증가는 미반영 = 기본 구간 단가)
	"grok-4.6": { input: 2.0, output: 6.0 },
	"grok-4.5": { input: 2.0, output: 6.0 },
	"grok-4.3": { input: 1.25, output: 2.5 },
	"grok-build-0.1": { input: 1.0, output: 2.0 },
	// DeepSeek (Naia 기본 모델 — 게이트웨이 오버레이가 SoT 지만, 라이브 갱신 전
	//  기본 모델이 $0 로 보이면 안 되므로 정적 폴백을 유지한다. #458 회귀 계약)
	"deepseek-v4-flash": { input: 0.209, output: 0.561 },
	// Anthropic (alias = naia-os registry/anthropic·claude-code-cli provider 모델 — 비용 $0 회귀 방지, 적대적 리뷰 H1)
	//  2026-08 공식가: fable-5 10/50, opus 4.6+ 5/25, sonnet 4.6·5 3/15, haiku-4.5 1/5.
	"claude-fable-5": { input: 10.0, output: 50.0 },
	"claude-opus-4-8": { input: 5.0, output: 25.0 },
	"claude-opus-4-7": { input: 5.0, output: 25.0 },
	"claude-opus-4-6": { input: 5.0, output: 25.0 },
	"claude-sonnet-5": { input: 3.0, output: 15.0 },
	"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	"claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
	"claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
	"claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
	"claude-opus-4-5-20251101": { input: 5.0, output: 25.0 },
	"claude-opus-4-1-20250805": { input: 15.0, output: 75.0 },
	"claude-opus-4-20250514": { input: 15.0, output: 75.0 },
	// OpenAI (2026-08 공식가 — o4-mini/o3 계열은 2026-10-23 shutdown 예고로 제거)
	"gpt-5.6-sol": { input: 4.0, output: 20.0 },
	"gpt-5.6-terra": { input: 2.0, output: 12.0 },
	"gpt-5.6-luna": { input: 0.2, output: 1.2 },
	"gpt-5.5": { input: 5.0, output: 30.0 },
	"gpt-5.4": { input: 2.5, output: 15.0 },
	"gpt-5.4-mini": { input: 0.75, output: 4.5 },
	"gpt-5-2025-08-07": { input: 1.25, output: 10.0 },
	"gpt-5-mini-2025-08-07": { input: 0.4, output: 1.6 },
	// gpt-5.2/5.1 = registry 에서 제거(deprecated 회색지대, 2026-06-18) → cost 도 동기화 제거.
	"gpt-4.1": { input: 2.0, output: 8.0 },
	"gpt-4.1-mini": { input: 0.4, output: 1.6 },
	"gpt-4.1-nano": { input: 0.1, output: 0.4 },
	"gpt-4o": { input: 2.5, output: 10.0 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	// Z.AI GLM — registry zai provider 모델(과금 0 회귀 방지). 2026-08 공식가 반영.
	//  glm-4.7/4.5-air 는 registry 라인업 제거와 동기화 삭제. 5.3-flash 는 프로모션가(~2026-09-09).
	"glm-5.3": { input: 1.4, output: 4.4 },
	"glm-5.3-flash": { input: 0.075, output: 0.25 },
	"glm-5.2": { input: 1.4, output: 4.4 },
	"glm-5.1": { input: 1.4, output: 4.4 },
	"glm-5-turbo": { input: 1.2, output: 4.0 },
};

// Live pricing overlay — populated from the Naia gateway GET /v1/pricing
// (adapters/gateway-pricing.ts). The gateway is the pricing SoT for models it
// routes (naia-agent#59; nextain/naia-shell#458: Pi models like
// deepseek-v4-flash/solar-pro4 were absent from the static table above and
// silently charged $0 in the shell). Static entries stay as the offline
// fallback for direct providers the gateway does not know.
const LIVE_PRICING: Record<string, { input: number; output: number }> = {};

/** Merge gateway pricing entries (bare model ids) into the live overlay.
 *  Pure state update — no I/O here; returns how many entries were applied. */
export function applyGatewayPricing(
	entries: ReadonlyArray<{ readonly model: string; readonly input: number; readonly output: number }>,
): number {
	let applied = 0;
	for (const e of entries) {
		if (!e.model || !Number.isFinite(e.input) || !Number.isFinite(e.output)) continue;
		LIVE_PRICING[e.model] = { input: e.input, output: e.output };
		applied++;
	}
	return applied;
}

/** per-token 과금에서 제외되는 provider — 사용자 구독으로 호출(과금 $0).
 *  claude-code-cli = Claude Agent SDK + 로컬 Claude Code 구독 인증(직접 키·게이트웨이 아님 → 사용자에게 토큰 비용 0).
 *  codex = 로컬 codex app-server + ChatGPT 로그인(구독) — 동일 모델 ID(gpt-5.x)를 openai(직접 키)도 쓰므로 provider 로 가른다. */
const SUBSCRIPTION_PROVIDERS = new Set(["claude-code-cli", "codex", "grok"]);

/**
 * 토큰 비용(USD). model 단가표 기반. provider 가 구독형(claude-code-cli)이면 **무조건 0**
 *  — 동일 model ID(claude-sonnet-4-6 등)를 anthropic(직접 키, per-token)도 쓰므로 model 만으론 못 가른다 → provider 로 분기.
 *  provider 미지정(기존 호출/테스트 호환) = model 단가표만 적용(anthropic·gemini 등 per-token 유지).
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number, provider?: string): number {
	if (provider && SUBSCRIPTION_PROVIDERS.has(provider)) return 0; // 구독 = $0(per-token 과금 제외)
	// Gateway-fetched pricing wins over the static fallback — the gateway
	// recomputes KRW-source rates weekly (naia-anyllm#66) and carries models
	// this table never listed.
	const pricing = LIVE_PRICING[model] ?? MODEL_PRICING[model];
	if (!pricing) return 0;
	return (pricing.input / 1_000_000) * inputTokens + (pricing.output / 1_000_000) * outputTokens;
}
