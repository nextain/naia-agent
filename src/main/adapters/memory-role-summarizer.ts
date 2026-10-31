import { buildLLMFactExtractor, buildLLMSummarizer } from "@nextain/naia-memory";
import type { CompactionSummarizer, FactExtractor } from "@nextain/naia-memory";
import { providerProcessingEndpoint } from "../domain/provider-route.js";
import type { ProviderConfig } from "../domain/chat.js";
import type { ProviderResolverPort } from "../ports/uc1.js";
import type { SubLlmCallOptions, SubLlmPort } from "../ports/sub-llm.js";
import { buildSubLlmProvider, withMainFallback, type SubLlmConfig, type SubLlmFetch } from "./sub-llm-provider.js";

/** Route a fallback through the selected main provider and authorize its actual destination. */
export function buildMainMemoryPort(config: ProviderConfig, resolver: ProviderResolverPort): SubLlmPort {
  const endpoint = providerProcessingEndpoint(config);
  const call: SubLlmPort["completeMessages"] = async (messages, opts) => {
    if (opts?.signal?.aborted) throw new Error("SUB_LLM_ABORTED");
    if (!endpoint || !opts?.authorizeAndDisclose || !await opts.authorizeAndDisclose({ workload: "sub_llm", provider: config.provider, model: config.model, endpoint, ...(opts.signal ? { signal: opts.signal } : {}) })) {
      throw new Error("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
    }
    if (opts?.signal?.aborted) throw new Error("SUB_LLM_ABORTED");
    let result = "";
    for await (const chunk of resolver.resolve(config).chat(config, messages, { signal: opts.signal })) {
      if (chunk.kind === "text") result += chunk.text;
    }
    return result;
  };
  return { provider: config.provider, model: config.model, endpoint, role: "main", complete: (prompt, opts) => call([{ role: "user", content: prompt }], opts), completeMessages: call };
}

function asPort(input: SubLlmConfig | SubLlmPort | undefined, fetch: SubLlmFetch, maxTokens: number): SubLlmPort | undefined {
  if (!input) return undefined;
  return "complete" in input ? input : buildSubLlmProvider(input, { fetch, strictResponse: true, maxTokens });
}

function markRole(port: SubLlmPort, role: "memory" | "main"): SubLlmPort {
  const bind = (opts?: SubLlmCallOptions): SubLlmCallOptions | undefined => opts?.authorizeAndDisclose
    ? { ...opts, authorizeAndDisclose: (input) => opts.authorizeAndDisclose!({ ...input, role }) }
    : opts;
  return { ...port, role, complete: (prompt, opts) => port.complete(prompt, bind(opts)), completeMessages: (messages, opts) => port.completeMessages(messages, bind(opts)) };
}

/** Build the established memory prompt but route its request through the role port. */
export function buildRoleMemorySummarizer(
  subConfig: SubLlmConfig | SubLlmPort,
  mainConfig: SubLlmConfig | SubLlmPort | undefined,
  fetch: SubLlmFetch,
  log: (event: { provider: string; model?: string; reason: string }) => void,
) {
  const sub = asPort(subConfig, fetch, 1024);
  if (!sub) throw new Error("memory sub role unavailable");
  const main = asPort(mainConfig, fetch, 1024);
  const port = withMainFallback(markRole(sub, sub.role ?? "memory"), main ? markRole(main, "main") : markRole(sub, sub.role ?? "memory"), log);
  return async (
    input: Parameters<CompactionSummarizer>[0],
    authorizeAndDisclose: NonNullable<SubLlmCallOptions["authorizeAndDisclose"]>,
  ) => {
    let transportError: unknown;
    const transport: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
      const prompt = body.messages?.[0]?.content;
      if (typeof prompt !== "string") throw new Error("invalid memory summary prompt");
      const result = await port.complete(prompt, { authorizeAndDisclose, ...(input.signal ? { signal: input.signal } : {}) }).catch((error: unknown) => { transportError = error; throw error; });
      return new Response(JSON.stringify({ choices: [{ message: { content: result } }] }), { status: 200 });
    };
    const options = { apiKey: "", baseURL: "https://memory.invalid/", model: sub.model, fetch: transport, failurePolicy: "throw" as const };
    const summarize = buildLLMSummarizer(options);
    try { return await summarize(input); } catch (error) { throw transportError ?? error; }
  };
}

/** Existing extraction prompt and safety parser, with a per-call authorized role transport. */
export function buildRoleMemoryExtractor(
  subConfig: SubLlmConfig | SubLlmPort,
  mainConfig: SubLlmConfig | SubLlmPort | undefined,
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
  const sub = asPort(subConfig, fetch, 8192);
  if (!sub) throw new Error("memory sub role unavailable");
  const main = asPort(mainConfig, fetch, 8192);
  const port = withMainFallback(checked(markRole(sub, sub.role ?? "memory")), main ? checked(markRole(main, "main")) : checked(markRole(sub, sub.role ?? "memory")), log);
  return async (episodes: Parameters<FactExtractor>[0], authorizeAndDisclose: NonNullable<SubLlmCallOptions["authorizeAndDisclose"]>, signal?: AbortSignal) => {
    let transportError: unknown;
    const transport: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
      const prompt = body.messages?.[0]?.content;
      if (typeof prompt !== "string") throw new Error("invalid memory extraction prompt");
      const result = await port.complete(prompt, { authorizeAndDisclose, ...(signal ? { signal } : {}) }).catch((error: unknown) => { transportError = error; throw error; });
      return new Response(JSON.stringify({ choices: [{ message: { content: result } }] }), { status: 200 });
    };
    const options = { apiKey: "", baseURL: "https://memory.invalid/", model: sub.model, fetch: transport, maxAttempts: 1, failurePolicy: "throw" as const };
    try { return await buildLLMFactExtractor(options)(episodes); } catch (error) { throw transportError ?? error; }
  };
}
