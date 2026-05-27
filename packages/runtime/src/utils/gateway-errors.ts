// naia-gateway error classification + cold-start retry (Slice 5-RB1.a / 5-RB1.b).
//
// gateway (any-llm Cloud Run) returns three Phase-1 specific statuses that
// naia-agent should translate to user-friendly stderr + exit 3, rather than
// generic provider errors:
//
//   401  body { error: "license-failed" }       → Tier A license unauth
//   402  body { error: "credit-insufficient" }  → Tier B credit empty
//   503  body { error: "pod-starting" }         → RunPod cold start, retry up to 5 min
//
// Pure (no fs / process / network), so unit tests run without msw or fake
// timers wiring at the module level. The bin caller wires `now` / `sleep`.

export type GatewayErrorClass =
  | "license-failed"
  | "credit-insufficient"
  | "pod-starting";

export interface GatewayError {
  cls: GatewayErrorClass;
  status: number;
  retryAfterSeconds?: number;
}

/**
 * Classify an HTTP status + body into one of the three Phase-1 error classes.
 * Returns `null` for statuses we leave to the generic provider handler.
 *
 * The body field is matched loosely: gateway emits `{ error: "<class>" }` but
 * some intermediaries (Cloud Run frontend) may strip the body to text/html on
 * 503 — in that case we still classify by status alone for `pod-starting`,
 * since 401/402 should never come from infra (only from the gateway app).
 */
export function classifyGatewayError(
  status: number,
  body?: unknown,
  retryAfterHeader?: string,
): GatewayError | null {
  const tag = extractErrorTag(body);
  if (status === 401 && tag === "license-failed") {
    return { cls: "license-failed", status };
  }
  if (status === 402 && tag === "credit-insufficient") {
    return { cls: "credit-insufficient", status };
  }
  if (status === 503 && (tag === "pod-starting" || tag === null)) {
    const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
    return retryAfterSeconds === undefined
      ? { cls: "pod-starting", status }
      : { cls: "pod-starting", status, retryAfterSeconds };
  }
  return null;
}

function extractErrorTag(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "error" in body) {
    const v = (body as { error: unknown }).error;
    if (typeof v === "string") return v;
  }
  return null;
}

function parseRetryAfter(header?: string): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  return undefined;
}

const PRICING_URL_BASE = "https://naia.nextain.io";

/**
 * Stderr message for a classified error. Korean default with English fallback
 * — `lang` is the BCP-47 short tag (e.g. "ko", "en", "ja", "zh"). Unknown
 * tags fall back to "ko" since naia.nextain.io ko/en are the only manuals
 * shipped at Phase 1 launch (see plan §2.5 — ja/zh are translation targets).
 */
export function formatGatewayErrorMessage(
  err: GatewayError,
  lang: string = "ko",
): string {
  const normalized = normalizeLang(lang);
  const url = `${PRICING_URL_BASE}/${normalized}/pricing`;
  const en = normalized === "en";
  switch (err.cls) {
    case "license-failed":
      return en
        ? `naia-agent: license required — see ${url}`
        : `naia-agent: 유료 인증이 필요합니다 — ${url}`;
    case "credit-insufficient":
      return en
        ? `naia-agent: credit insufficient — top up at ${url}`
        : `naia-agent: 크레딧이 부족합니다 — ${url}`;
    case "pod-starting":
      return en
        ? `naia-agent: Pod starting (1–3 min expected, 5 min cap)...`
        : `naia-agent: naia Pod 준비 중입니다 (1–3분 예상, 최대 5분)...`;
  }
}

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase();
  if (lower === "en" || lower.startsWith("en-")) return "en";
  if (lower === "ja" || lower.startsWith("ja-")) return "ja";
  if (lower === "zh" || lower.startsWith("zh-")) return "zh";
  // POSIX defaults (LANG=C / C.UTF-8) are English-by-convention, not Korean.
  // Pre-launch ko/en are the only shipped manuals; CI runs hit "c" here.
  if (lower === "c" || lower === "posix" || lower === "") return "en";
  return "ko";
}

/**
 * Cold-start retry policy. Total elapsed time is capped at 5 min (plan §0.6).
 *
 * Schedule: 5s, 10s, 20s, 40s, 60s, 60s, ... (exponential up to 60s).
 * Retry-After hint (server-sent) overrides the schedule when present, but
 * is still clamped to [1s, 60s] to avoid a malicious header tying up the
 * agent for hours.
 */
export const COLD_START_MAX_ELAPSED_MS = 300_000;
export const COLD_START_BASE_DELAY_MS = 5_000;
export const COLD_START_MAX_DELAY_MS = 60_000;

export function coldStartDelayMs(
  attempt: number,
  retryAfterSeconds?: number,
): number {
  if (retryAfterSeconds !== undefined) {
    const ms = retryAfterSeconds * 1000;
    return clamp(ms, 1_000, COLD_START_MAX_DELAY_MS);
  }
  const exp = COLD_START_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  return Math.min(exp, COLD_START_MAX_DELAY_MS);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Stderr message when the 5-min cap is exceeded (Slice 5-RB1.b). */
export function coldStartTimeoutMessage(lang: string = "ko"): string {
  return normalizeLang(lang) === "en"
    ? `naia-agent: cold start exceeded 5 min — please retry shortly.`
    : `naia-agent: cold start이 5분을 초과했습니다 — 잠시 후 다시 시도하세요.`;
}

/**
 * Public lang-tag reducer used by callers that compose their own ko/en
 * strings (e.g. the bin's `onPodStarting` suffix). Keeping the dispatch in
 * one place avoids the partial-fix bug found in R2 cross-review where
 * `coldStartTimeoutMessage` and the bin used raw `lang === "en"` while
 * `formatGatewayErrorMessage` normalized — POSIX locales saw mixed-lang stderr.
 */
export function isEnglishLocale(lang: string): boolean {
  return normalizeLang(lang) === "en";
}
