// adapters/gateway-pricing — Naia gateway GET /v1/pricing → domain cost overlay.
//
// The gateway is the pricing SoT for every model it routes (naia-agent#59 gap
// "게이트웨이 pricing fetch"; nextain/naia-shell#458: Pi models charged $0 in the
// shell because the static table never listed them, and hardcoding each new
// model is exactly what the user rejected). Refresh is fire-and-forget and
// throttled: pricing changes weekly (naia-anyllm#66), so one fetch per
// interval is plenty. Failure is silent — the static fallback still applies.
import { applyGatewayPricing } from "../domain/cost.js";

const DEFAULT_GATEWAY_BASE = "https://api.nextain.io";
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1h — weekly-changing data
let lastAttemptAt = 0;
let inFlight: Promise<number> | null = null;

interface GatewayPricingEntry {
	readonly model_key?: string;
	readonly input_price_per_million?: number;
	readonly output_price_per_million?: number;
}

/** Strip the route prefix ("azure:deepseek-v4-flash" → "deepseek-v4-flash"). */
function bareModelId(modelKey: string): string {
	const idx = modelKey.indexOf(":");
	return idx >= 0 ? modelKey.slice(idx + 1) : modelKey;
}

/**
 * Refresh the live pricing overlay from the gateway. Throttled, single-flight,
 * never throws. Returns the number of applied entries (0 on skip/failure).
 */
export async function ensureGatewayPricing(gatewayUrl?: string): Promise<number> {
	const now = Date.now();
	if (inFlight) return inFlight;
	if (now - lastAttemptAt < REFRESH_INTERVAL_MS) return 0;
	lastAttemptAt = now;
	const base = (gatewayUrl?.trim() || DEFAULT_GATEWAY_BASE).replace(/\/+$/, "");
	inFlight = (async () => {
		try {
			const resp = await fetch(`${base}/v1/pricing`, {
				signal: AbortSignal.timeout(5000),
			});
			if (!resp.ok) return 0;
			const raw: unknown = await resp.json();
			if (!Array.isArray(raw)) return 0;
			return applyGatewayPricing(
				(raw as GatewayPricingEntry[])
					.filter((e) => typeof e.model_key === "string")
					.map((e) => ({
						model: bareModelId(e.model_key as string),
						input: Number(e.input_price_per_million),
						output: Number(e.output_price_per_million),
					})),
			);
		} catch {
			return 0; // offline / gateway down — static fallback stays in force
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Test hook: reset the throttle so a spec can force a refresh. */
export function resetGatewayPricingThrottleForTest(): void {
	lastAttemptAt = 0;
}
