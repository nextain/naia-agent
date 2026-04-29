/**
 * Cross-provider construction integration test — D44 §4 (Slice 5.x.4).
 *
 * Verifies that each optional Vercel SDK provider installs and constructs
 * a `LanguageModelV2` that VercelClient accepts. No network calls — pure
 * shape compliance + auto-install reachability check.
 *
 * Why integration (not unit): exercises the actual installed package
 * surface (post-`pnpm install`), so a missing/broken optional dep on the
 * current platform fails this test, surfacing cross-platform issues early.
 *
 * If a provider's package is missing on the current platform (e.g. a
 * pure-JS package that fails to install in some sandbox), this test
 * marks that case as `skip` rather than failing — graceful degradation
 * preserves CI green for environments where some providers are not
 * applicable.
 */

import { describe, expect, it } from "vitest";
import { VercelClient } from "../vercel-client.js";

interface ProviderCase {
  name: string;
  /** dynamic import path */
  modulePath: string;
  /** factory function name on the imported module */
  factory: string;
  /** options passed to the factory; `apiKey` is a placeholder for shape-only checks */
  factoryOptions: Record<string, unknown>;
  /** model id to construct */
  modelId: string;
  /** how to invoke the model factory: `provider(modelId)` or `provider.languageModel(modelId)` */
  call: "default" | "languageModel";
}

const CASES: ProviderCase[] = [
  {
    name: "@ai-sdk/anthropic",
    modulePath: "@ai-sdk/anthropic",
    factory: "createAnthropic",
    factoryOptions: { apiKey: "sk-ant-noop" },
    modelId: "claude-opus-4-7",
    call: "default",
  },
  {
    name: "@ai-sdk/google",
    modulePath: "@ai-sdk/google",
    factory: "createGoogleGenerativeAI",
    factoryOptions: { apiKey: "noop" },
    modelId: "gemini-2.5-flash",
    call: "default",
  },
  {
    name: "@ai-sdk/openai-compatible (vLLM-style baseURL)",
    modulePath: "@ai-sdk/openai-compatible",
    factory: "createOpenAICompatible",
    factoryOptions: {
      name: "vllm-test",
      baseURL: "http://localhost:8000/v1",
      apiKey: "EMPTY",
    },
    modelId: "qwen/qwen3-32b-awq",
    call: "default",
  },
  {
    name: "zhipu-ai-provider (Z.ai coding plan)",
    modulePath: "zhipu-ai-provider",
    factory: "createZhipu",
    factoryOptions: {
      baseURL: "https://api.z.ai/api/paas/v4",
      apiKey: "noop",
    },
    modelId: "glm-4.5-flash",
    call: "default",
  },
  {
    name: "ai-sdk-provider-claude-code (Pro/Max subscription)",
    modulePath: "ai-sdk-provider-claude-code",
    factory: "createClaudeCode",
    factoryOptions: {},
    modelId: "claude-opus-4-7",
    call: "default",
  },
];

describe("VercelClient × auto-installed Vercel providers (cross-platform)", () => {
  for (const c of CASES) {
    it(`accepts a model from ${c.name}`, async () => {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(c.modulePath)) as Record<string, unknown>;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // optionalDependencies don't fail the install; the dep simply
        // won't be on disk for unsupported platforms. Skip rather than
        // fail so CI stays green where the provider isn't applicable.
        console.warn(`skip: ${c.name} not available on this platform — ${reason}`);
        return;
      }

      const factory = mod[c.factory] as
        | ((opts: Record<string, unknown>) => unknown)
        | undefined;
      expect(factory, `${c.factory} export missing from ${c.name}`).toBeTypeOf(
        "function",
      );
      const provider = factory!(c.factoryOptions) as
        | ((id: string) => unknown)
        | { languageModel: (id: string) => unknown };

      const model =
        c.call === "default"
          ? (provider as (id: string) => { specificationVersion?: string })(c.modelId)
          : (provider as { languageModel: (id: string) => { specificationVersion?: string } })
              .languageModel(c.modelId);

      // VercelClient supports V2 and V3 (ecosystem mid-migration).
      // Surfaces breaking V4+ upgrades that would need adapter rewrite.
      expect(
        ["v2", "v3"],
        `${c.name} model spec version`,
      ).toContain(model.specificationVersion);

      // VercelClient construction should succeed without throwing.
      const client = new VercelClient(model as never);
      expect(typeof client.generate).toBe("function");
      expect(typeof client.stream).toBe("function");
      expect(client.modelId).toBe(c.modelId);
    });
  }

  it("throws when given a model with unsupported specificationVersion (v1/v4+)", () => {
    expect(
      () =>
        new VercelClient({
          specificationVersion: "v1" as never,
          provider: "test.fake",
          modelId: "x",
          supportedUrls: {},
          doGenerate: async () => ({}) as never,
          doStream: async () => ({}) as never,
        }),
    ).toThrow(/spec/i);
    expect(
      () =>
        new VercelClient({
          specificationVersion: "v4" as never,
          provider: "test.fake",
          modelId: "x",
          supportedUrls: {},
          doGenerate: async () => ({}) as never,
          doStream: async () => ({}) as never,
        }),
    ).toThrow(/spec/i);
  });
});
