// domain/cost — per-million-token 가격표 + cost 계산 (old-naia-os/agent/src/providers/cost.ts verbatim 이식).
// 순수 함수. model 미등록 = 0(크래시 아님 — 셸 formatCost 가 0 도 안전 렌더).
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	// Gemini 3.x
	"gemini-3.5-flash": { input: 1.65, output: 9.9 },
	"gemini-3-pro-preview": { input: 2.0, output: 12.0 },
	"gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
	"gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
	"gemini-3-flash-preview": { input: 0.5, output: 3.0 },
	// Gemini 2.5
	"gemini-2.5-flash": { input: 0.3, output: 2.5 },
	"gemini-2.5-flash-lite-preview-06-17": { input: 0.15, output: 1.0 },
	"gemini-2.5-pro": { input: 1.25, output: 10.0 },
	// Gemini 2.0
	"gemini-2.0-flash-001": { input: 0.1, output: 0.4 },
	"gemini-2.0-flash-lite-preview-02-05": { input: 0.075, output: 0.3 },
	// xAI
	"grok-4.3": { input: 1.25, output: 2.5 },
	"grok-4.1-fast": { input: 5.0, output: 25.0 },
	"grok-4": { input: 3.0, output: 15.0 },
	"grok-4-1-fast-reasoning": { input: 5.0, output: 25.0 },
	"grok-4-1-fast-non-reasoning": { input: 3.0, output: 15.0 },
	"grok-4-fast-reasoning": { input: 5.0, output: 25.0 },
	"grok-code-fast-1": { input: 3.0, output: 15.0 },
	"grok-3": { input: 3.0, output: 15.0 },
	"grok-3-fast": { input: 5.0, output: 25.0 },
	"grok-3-mini": { input: 0.3, output: 0.5 },
	"grok-3-mini-fast": { input: 0.6, output: 4.0 },
	// Anthropic (alias = naia-os registry/anthropic·claude-code-cli provider 모델 — 비용 $0 회귀 방지, 적대적 리뷰 H1)
	"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	"claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
	"claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
	"claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
	"claude-opus-4-5-20251101": { input: 15.0, output: 75.0 },
	"claude-opus-4-1-20250805": { input: 15.0, output: 75.0 },
	"claude-opus-4-20250514": { input: 15.0, output: 75.0 },
	"claude-opus-4-8": { input: 15.0, output: 75.0 },
	"claude-opus-4-6": { input: 15.0, output: 75.0 },
	"claude-3-7-sonnet-20250219": { input: 3.0, output: 15.0 },
	// OpenAI
	"gpt-5-2025-08-07": { input: 1.25, output: 10.0 },
	"gpt-5-mini-2025-08-07": { input: 0.4, output: 1.6 },
	"gpt-5.5": { input: 1.25, output: 10.0 },
	"gpt-5.4": { input: 1.25, output: 10.0 },
	// gpt-5.2/5.1 = registry 에서 제거(deprecated 회색지대, 2026-06-18) → cost 도 동기화 제거.
	"gpt-4.1": { input: 2.0, output: 8.0 },
	"gpt-4.1-mini": { input: 0.4, output: 1.6 },
	"gpt-4.1-nano": { input: 0.1, output: 0.4 },
	"o4-mini": { input: 1.1, output: 4.4 },
	"o3-mini": { input: 1.1, output: 4.4 },
	"gpt-4o": { input: 2.5, output: 10.0 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	// Z.AI GLM — registry zai provider 모델(과금 0 회귀 방지). z.ai coding plan 은 quota 구독이라
	//  per-token 은 근사 추정치(사용자 검증 필요). registry.ts zai 라인업과 ID 1:1 정합 유지.
	"glm-5.2": { input: 0.6, output: 2.2 },
	"glm-5.1": { input: 0.6, output: 2.2 },
	"glm-5-turbo": { input: 0.1, output: 0.3 },
	"glm-4.7": { input: 0.6, output: 2.2 },
	"glm-4.5-air": { input: 0.1, output: 0.3 },
};

/** per-token 과금에서 제외되는 provider — 사용자 구독으로 호출(과금 $0).
 *  claude-code-cli = Claude Agent SDK + 로컬 Claude Code 구독 인증(직접 키·게이트웨이 아님 → 사용자에게 토큰 비용 0). */
const SUBSCRIPTION_PROVIDERS = new Set(["claude-code-cli"]);

/**
 * 토큰 비용(USD). model 단가표 기반. provider 가 구독형(claude-code-cli)이면 **무조건 0**
 *  — 동일 model ID(claude-sonnet-4-6 등)를 anthropic(직접 키, per-token)도 쓰므로 model 만으론 못 가른다 → provider 로 분기.
 *  provider 미지정(기존 호출/테스트 호환) = model 단가표만 적용(anthropic·gemini 등 per-token 유지).
 */
export function calculateCost(model: string, inputTokens: number, outputTokens: number, provider?: string): number {
	if (provider && SUBSCRIPTION_PROVIDERS.has(provider)) return 0; // 구독 = $0(per-token 과금 제외)
	const pricing = MODEL_PRICING[model];
	if (!pricing) return 0;
	return (pricing.input / 1_000_000) * inputTokens + (pricing.output / 1_000_000) * outputTokens;
}
