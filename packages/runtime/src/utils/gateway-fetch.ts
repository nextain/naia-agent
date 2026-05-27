// Slice 5-RB1.a / 5-RB1.b — fetch wrapper that classifies naia-gateway
// errors and applies the cold-start retry policy.
//
// Intent: be the `fetch` argument passed to @ai-sdk/openai-compatible so
// every model call through the manifest pipeline gets uniform error
// handling. Pure besides the injected fetch; process.exit lives in the bin
// caller (onFatalError) so tests can mock it.

import {
  classifyGatewayError,
  coldStartDelayMs,
  coldStartTimeoutMessage,
  formatGatewayErrorMessage,
  COLD_START_MAX_ELAPSED_MS,
  type GatewayErrorClass,
} from "./gateway-errors.js";

export interface GatewayFetchDeps {
  rawFetch?: typeof fetch;
  lang?: string;
  /** Invoked on license-failed / credit-insufficient / timeout. Must not return. */
  onFatalError: (cls: GatewayErrorClass | "timeout", message: string) => never;
  /** Notify host of cold-start wait (first occurrence only) — stderr write. */
  onPodStarting?: (message: string, waitMs: number, attempt: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override 5-min cap (tests). */
  maxElapsedMs?: number;
}

export function makeGatewayFetch(deps: GatewayFetchDeps): typeof fetch {
  const rawFetch = deps.rawFetch ?? globalThis.fetch;
  const lang = deps.lang ?? "ko";
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cap = deps.maxElapsedMs ?? COLD_START_MAX_ELAPSED_MS;

  return async function gatewayFetch(input, init) {
    const start = now();
    let attempt = 0;
    while (true) {
      const res = await rawFetch(input as RequestInfo | URL, init);
      if (res.status !== 401 && res.status !== 402 && res.status !== 503) {
        return res;
      }
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        /* not JSON — classifyGatewayError handles via status alone */
      }
      const retryAfter = res.headers.get("Retry-After") ?? undefined;
      const err = classifyGatewayError(res.status, body, retryAfter);
      if (err === null) {
        // Unrecognized 401/402/503 shape — pass through unchanged so the
        // SDK surfaces the original provider error.
        return res;
      }
      if (err.cls === "license-failed" || err.cls === "credit-insufficient") {
        deps.onFatalError(err.cls, formatGatewayErrorMessage(err, lang));
      }
      // pod-starting → retry with backoff
      const wait = coldStartDelayMs(attempt, err.retryAfterSeconds);
      const elapsed = now() - start;
      if (elapsed + wait > cap) {
        deps.onFatalError("timeout", coldStartTimeoutMessage(lang));
      }
      // Fire on every retry — host sees an alive-signal each cycle, not just
      // a single 5-min-ago "starting" hint (reasoning-aud r1 MEDIUM).
      deps.onPodStarting?.(
        formatGatewayErrorMessage({ cls: "pod-starting", status: 503 }, lang),
        wait,
        attempt + 1,
      );
      attempt += 1;
      await sleep(wait);
    }
  };
}
