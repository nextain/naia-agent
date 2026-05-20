// `naia-agent --memory` pure decision logic — extracted from bin so it is
// unit-tested (slice gate; mirrors login-spec/classifyProbe extraction).
//
// (1) normalizeEmbedBaseUrl: OpenAICompatEmbeddingProvider unconditionally
//     appends `/v1/embeddings`; naia-settings keeps every role's baseUrl
//     uniform (`…/v1`, needed by the chat role). Strip a single trailing
//     `/v1` so the composed URL is `…/v1/embeddings`, NOT `…/v1/v1/…` (404).
//     General — the only assumption is "a trailing `/v1` is the uniform
//     naia-settings suffix, not a real path segment" (true for all
//     naia-settings-produced bases). Guard the provider's own Gemini
//     discriminator (`…/openai$`) so the two heuristics cannot disagree.
// (2) decideCliMemory: the fallback gate (missing/invalid `embedded`).

export function normalizeEmbedBaseUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const stripped = trimmed.replace(/\/v1$/, "");
  // If stripping would expose a Gemini-compat base (`…/openai`), the
  // provider would switch to `${base}/embeddings` and silently drop the
  // `/v1` — keep the original in that pathological case.
  if (/\/openai$/.test(stripped) && !/\/openai$/.test(trimmed)) return trimmed;
  return stripped;
}

export interface CliMemoryDecision {
  kind: "lite" | "ephemeral";
  reason?: string;
  base?: string;
  model?: string;
  dims?: number;
}

/** Decide lite vs ephemeral purely from env (no I/O). */
export function decideCliMemory(env: NodeJS.ProcessEnv): CliMemoryDecision {
  const base = env["NAIA_EMBED_BASE_URL"];
  const model = env["NAIA_EMBED_MODEL"];
  const dims = Number(env["NAIA_EMBED_DIMS"]);
  if (!base || !model || !Number.isInteger(dims) || dims <= 0) {
    return {
      kind: "ephemeral",
      reason:
        "--memory needs a valid 'embedded' role (run `naia-agent login --embedded \"provider|baseUrl|model|dims\"` or fix naia-settings/llm.json)",
    };
  }
  return { kind: "lite", base: normalizeEmbedBaseUrl(base), model, dims };
}
