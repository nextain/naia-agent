// gateway-pricing — live pricing overlay from the Naia gateway (naia-agent#59;
// nextain/naia-shell#458: Pi models charged $0 because the static table never
// listed them and hardcoding each new model was rejected by the user).
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyGatewayPricing, calculateCost } from "../main/domain/cost.js";
import type { AgentEmit, ProviderConfig } from "../main/domain/chat.js";
import type { ProviderPort } from "../main/ports/uc1.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import {
	ensureGatewayPricing,
	resetGatewayPricingThrottleForTest,
} from "../main/adapters/gateway-pricing.js";

afterEach(() => {
	vi.unstubAllGlobals();
	resetGatewayPricingThrottleForTest();
});

describe("domain cost — gateway pricing overlay", () => {
	it("keeps DeepSeek V4 Flash cost non-zero before the live refresh", () => {
		expect(calculateCost("deepseek-v4-flash", 1_000_000, 1_000_000)).toBeCloseTo(0.77, 6);
	});

	it("a model absent from the static table costs 0 until the overlay arrives", () => {
		expect(calculateCost("model-not-in-any-table", 1_000_000, 1_000_000)).toBe(0);
	});

	it("applyGatewayPricing makes an unlisted model bill correctly", () => {
		const applied = applyGatewayPricing([
			{ model: "test-overlay-flash", input: 0.209, output: 0.561 },
		]);
		expect(applied).toBe(1);
		expect(
			calculateCost("test-overlay-flash", 1_000_000, 1_000_000),
		).toBeCloseTo(0.209 + 0.561, 6);
	});

	it("the overlay wins over a stale static entry", () => {
		// gemini-2.5-flash static = 0.3/2.5 — a gateway update must take over.
		applyGatewayPricing([{ model: "gemini-2.5-flash", input: 1.0, output: 2.0 }]);
		expect(calculateCost("gemini-2.5-flash", 1_000_000, 0)).toBeCloseTo(1.0, 6);
	});

	it("rejects malformed entries without applying them", () => {
		expect(
			applyGatewayPricing([
				{ model: "", input: 1, output: 1 },
				{ model: "bad-nan", input: Number.NaN, output: 1 },
			]),
		).toBe(0);
	});
});

describe("adapters gateway-pricing — fetch and merge", () => {
	it("fetches /v1/pricing, strips route prefixes, and applies entries", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [
				{ model_key: "azure:fetch-test-model", input_price_per_million: 0.5, output_price_per_million: 1.5 },
				{ model_key: "upstage:fetch-test-solar", input_price_per_million: 0.33, output_price_per_million: 1.32 },
				{ model_key: "motif:motif-3", input_price_per_million: 0.22, output_price_per_million: 0.88, cached_price_per_million: 0.044 },
			],
		});
		vi.stubGlobal("fetch", fetchMock);
		const applied = await ensureGatewayPricing("https://gw.example");
		expect(applied).toBe(3);
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://gw.example/v1/pricing");
		expect(calculateCost("fetch-test-model", 1_000_000, 0)).toBeCloseTo(0.5, 6);
		expect(calculateCost("motif-3", 1_000_000, 1_000_000)).toBeCloseTo(1.1, 6);
	});

	it("null 가격·비-per_token 항목은 오버레이에 반영하지 않는다(Number(null)=0 오염 방지)", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [
				// null 가격 = 미책정 — 0 으로 덮어쓰면 정적 단가표를 오염시킨다.
				{ model_key: "gemini:gemini-2.5-flash", input_price_per_million: null, output_price_per_million: null },
				// per_hour 모델의 per-million 필드는 토큰 과금 단가가 아니다.
				{ model_key: "vllm:hourly-model", input_price_per_million: 0.39, output_price_per_million: 0, pricing_unit: "per_hour" },
				{ model_key: "azure:valid-token-model", input_price_per_million: 0.5, output_price_per_million: 1.5, pricing_unit: "per_token" },
			],
		});
		vi.stubGlobal("fetch", fetchMock);
		const applied = await ensureGatewayPricing("https://gw.example");
		expect(applied).toBe(1);
		// 정적 단가는 그대로 살아 있다(0 으로 오염되지 않음).
		expect(calculateCost("gemini-2.5-flash", 1_000_000, 0)).toBeGreaterThan(0);
		expect(calculateCost("hourly-model", 1_000_000, 0)).toBe(0);
		expect(calculateCost("valid-token-model", 1_000_000, 0)).toBeCloseTo(0.5, 6);
	});

	it("network failure is silent and leaves the static fallback in force", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
		await expect(ensureGatewayPricing()).resolves.toBe(0);
		// Static entry still works.
		expect(calculateCost("gpt-4o", 1_000_000, 0)).toBeCloseTo(2.5, 6);
	});

	it("throttles: a second call within the interval does not re-fetch", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
		vi.stubGlobal("fetch", fetchMock);
		await ensureGatewayPricing("https://gw.example");
		await ensureGatewayPricing("https://gw.example");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("wireAgentUC1 chat turn — gateway pricing cost calculation", () => {
	function makeUsageProvider(inputTokens: number, outputTokens: number): ProviderPort {
		return {
			async *chat() {
				yield { kind: "text", text: "ok." };
				yield { kind: "usage", inputTokens, outputTokens };
				yield { kind: "finish" };
			},
		};
	}

	async function runTurn(providerConfig: ProviderConfig, inputTokens = 100_000, outputTokens = 50_000) {
		const emitted: AgentEmit[] = [];
		const { handler } = wireAgentUC1({
			provider: makeUsageProvider(inputTokens, outputTokens),
			egress: { emit: (_reqId, e) => emitted.push(e) },
		});
		await handler.onChatRequest({
			kind: "chat",
			requestId: "req-pricing-1",
			provider: providerConfig,
			messages: [{ role: "user", content: "hi" }],
		});
		return emitted;
	}

	it("fetches /v1/pricing from configured labGatewayUrl on a Naia turn and computes usage cost", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [
				{
					model_key: "motif:motif-3",
					input_price_per_million: 0.22,
					output_price_per_million: 0.88,
				},
			],
		});
		vi.stubGlobal("fetch", fetchMock);

		const emitted = await runTurn(
			{
				provider: "nextain",
				model: "motif-3",
				labGatewayUrl: "https://gw-test.example",
			},
			100_000,
			50_000,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe("https://gw-test.example/v1/pricing");
		const usage = emitted.find((e): e is Extract<AgentEmit, { kind: "usage" }> => e.kind === "usage");
		expect(usage).toBeDefined();
		expect(usage?.cost).toBeCloseTo((100_000 * 0.22 + 50_000 * 0.88) / 1_000_000, 8);
		expect(emitted.at(-1)?.kind).toBe("finish");
	});

	it("completes without throwing and falls back to 0 or static price when /v1/pricing fails", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("gateway unreachable"));
		vi.stubGlobal("fetch", fetchMock);

		const unpricedEmitted = await runTurn({
			provider: "nextain",
			model: "unlisted-gateway-model",
			labGatewayUrl: "https://gw-test.example",
		});
		const unpricedUsage = unpricedEmitted.find(
			(e): e is Extract<AgentEmit, { kind: "usage" }> => e.kind === "usage",
		);
		expect(unpricedUsage?.cost).toBe(0);
		expect(unpricedEmitted.at(-1)?.kind).toBe("finish");

		resetGatewayPricingThrottleForTest();
		const staticEmitted = await runTurn(
			{
				provider: "nextain",
				model: "deepseek-v4-flash",
				labGatewayUrl: "https://gw-test.example",
			},
			1_000_000,
			1_000_000,
		);
		const staticUsage = staticEmitted.find(
			(e): e is Extract<AgentEmit, { kind: "usage" }> => e.kind === "usage",
		);
		expect(staticUsage?.cost).toBeCloseTo(0.209 + 0.561, 6);
		expect(staticEmitted.at(-1)?.kind).toBe("finish");
	});

	it("does not call /v1/pricing for non-Naia providers (direct API key or subscription)", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
		vi.stubGlobal("fetch", fetchMock);

		await runTurn({ provider: "openai", model: "gpt-4o" });
		await runTurn({ provider: "claude-code-cli", model: "claude-sonnet-4-6" });

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
