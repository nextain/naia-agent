import { buildLLMFactExtractor, buildLLMSummarizer } from "@nextain/naia-memory";
import type { CompactionSummarizer, FactExtractor } from "@nextain/naia-memory";
import type { SubLlmCallOptions, SubLlmPort } from "../ports/sub-llm.js";
import { buildSubLlmProvider, withMainFallback, type SubLlmConfig, type SubLlmFetch } from "./sub-llm-provider.js";

/** Build the established memory prompt but route its request through the role port. */
export function buildRoleMemorySummarizer(
  subConfig: SubLlmConfig,
  mainConfig: SubLlmConfig | undefined,
  fetch: SubLlmFetch,
  log: (event: { provider: string; model?: string; reason: string }) => void,
) {
  const sub = buildSubLlmProvider(subConfig, { fetch, strictResponse: true, maxTokens: 1024 });
  if (!sub) throw new Error("memory sub role unavailable");
  const main = mainConfig ? buildSubLlmProvider(mainConfig, { fetch, strictResponse: true, maxTokens: 1024 }) : undefined;
  const port = withMainFallback(sub, main ?? sub, log);
  return async (
    input: Parameters<CompactionSummarizer>[0],
    authorizeAndDisclose: NonNullable<SubLlmCallOptions["authorizeAndDisclose"]>,
  ) => {
    const transport: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
      const prompt = body.messages?.[0]?.content;
      if (typeof prompt !== "string") throw new Error("invalid memory summary prompt");
      const result = await port.complete(prompt, { authorizeAndDisclose, ...(input.signal ? { signal: input.signal } : {}) });
      return new Response(JSON.stringify({ choices: [{ message: { content: result } }] }), { status: 200 });
    };
    const options = { apiKey: "", baseURL: "https://memory.invalid/", model: sub.model, fetch: transport, failurePolicy: "throw" };
    const summarize = buildLLMSummarizer(options);
    return summarize(input);
  };
}

/** Existing extraction prompt and safety parser, with a per-call authorized role transport. */
export function buildRoleMemoryExtractor(
  subConfig: SubLlmConfig,
  mainConfig: SubLlmConfig | undefined,
  fetch: SubLlmFetch,
  log: (event: { provider: string; model?: string; reason: string }) => void,
) {
  const checked = (port: SubLlmPort): SubLlmPort => ({
    ...port,
    async complete(prompt, opts) {
      const result = await port.complete(prompt, opts);
      const raw = result.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Error("SUB_LLM_INVALID_RESPONSE"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SUB_LLM_INVALID_RESPONSE");
      return result;
    },
  });
  const sub = buildSubLlmProvider(subConfig, { fetch, strictResponse: true, maxTokens: 8192 });
  if (!sub) throw new Error("memory sub role unavailable");
  const main = mainConfig ? buildSubLlmProvider(mainConfig, { fetch, strictResponse: true, maxTokens: 8192 }) : undefined;
  const port = withMainFallback(checked(sub), main ? checked(main) : checked(sub), log);
  return async (episodes: Parameters<FactExtractor>[0], authorizeAndDisclose: NonNullable<SubLlmCallOptions["authorizeAndDisclose"]>, signal?: AbortSignal) => {
    const transport: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
      const prompt = body.messages?.[0]?.content;
      if (typeof prompt !== "string") throw new Error("invalid memory extraction prompt");
      const result = await port.complete(prompt, { authorizeAndDisclose, ...(signal ? { signal } : {}) });
      return new Response(JSON.stringify({ choices: [{ message: { content: result } }] }), { status: 200 });
    };
    const options = { apiKey: "", baseURL: "https://memory.invalid/", model: sub.model, fetch: transport, maxAttempts: 1, failurePolicy: "throw" as const };
    return buildLLMFactExtractor(options)(episodes);
  };
}
