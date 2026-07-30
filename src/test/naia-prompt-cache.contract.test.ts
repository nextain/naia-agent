import { describe, expect, it } from "vitest";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import type { ProviderChunk, ProviderConfig } from "../main/domain/chat.js";

async function collect(stream: AsyncIterable<ProviderChunk>): Promise<void> {
  for await (const _chunk of stream) { /* consume */ }
}

function captureBodies() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) },
    };
  };
  return { bodies, fetch };
}

const naiaConfig = (model: string): ProviderConfig => ({
  provider: "nextain",
  model,
  naiaKey: "test-naia-key",
});

describe("REQ-AGENT-095 Naia GPT-5.6 prompt-cache shard", () => {
  it("is stable for exact UTF-8 prefix bytes and isolated by prefix and model", async () => {
    const { bodies, fetch } = captureBodies();
    const resolver = makeProviderResolver({ fetch: fetch as never });
    for (const [model, systemPrompt] of [
      ["gpt-5.6-sol", "stable α"],
      ["gpt-5.6-sol", "stable α"],
      ["gpt-5.6-sol", "stable  α"],
      ["gpt-5.6-luna", "stable α"],
    ] as const) {
      const config = naiaConfig(model);
      await collect(resolver.resolve(config).chat(config, [{ role: "user", content: "hi" }], { systemPrompt }));
    }

    const keys = bodies.map((body) => body.prompt_cache_key);
    expect(keys[0]).toMatch(/^agent-[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("does not add cache fields to unrelated Naia or native routes", async () => {
    const { bodies, fetch } = captureBodies();
    const resolver = makeProviderResolver({ fetch: fetch as never });
    const grok = naiaConfig("grok-4.3");
    await collect(resolver.resolve(grok).chat(grok, [], { systemPrompt: "stable" }));
    const native: ProviderConfig = { provider: "openai", model: "gpt-5.6-sol", apiKey: "test" };
    await collect(resolver.resolve(native).chat(native, [], { systemPrompt: "stable" }));
    expect(bodies.map((body) => body.prompt_cache_key)).toEqual([undefined, undefined]);
  });
});
