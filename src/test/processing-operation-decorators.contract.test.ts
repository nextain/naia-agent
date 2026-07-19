import { describe, expect, it, vi } from "vitest";
import {
  makeProcessingAwareEmbedding,
  makeProcessingAwareMemoryLlm,
  makeProcessingAwareProvider,
  makeProcessingAwareResolver,
  makeProcessingAwareToolExecutor,
  runWithProcessingRequestContext,
} from "../main/adapters/processing-operation-decorators.js";
import { makeProcessingRequestContext } from "../main/adapters/processing-request-context.js";
import type { ProviderChunk } from "../main/domain/chat.js";
import type { ProviderPort } from "../main/ports/uc1.js";
import type { ProcessingOperation } from "../main/ports/processing.js";
import { ensureCurrentProcessingAuthorized } from "../main/adapters/processing-operation-decorators.js";
import { makeRadioDjContext } from "../main/adapters/radio-dj-runtime.js";

const config = { provider: "openai", model: "gpt-5" };
const trusted = {
  endpointUrl: "https://api.openai.com/v1",
  endpointZone: "unverified" as const,
  requiresConsent: true,
};

async function drain(stream: AsyncIterable<ProviderChunk>) {
  for await (const _chunk of stream) { /* drain */ }
}

describe("actual provider-operation decorator", () => {
  it("authorizes every actual chat when resolver returns a fresh provider each round", async () => {
    const providerCalls = vi.fn();
    const resolver = makeProcessingAwareResolver({
      resolve: () => ({
        async *chat() {
          providerCalls();
          yield { kind: "finish" as const };
        },
      }),
    }, () => trusted);
    const authorize = vi.fn(async () => {});
    const context = makeProcessingRequestContext(authorize);
    await runWithProcessingRequestContext(context, async () => {
      await drain(resolver.resolve(config).chat(config, [], {}));
      await drain(resolver.resolve(config).chat(config, [], {}));
    });
    expect(providerCalls).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("proactive weather outside a request context fails closed and is omitted", async () => {
    const networkFetch = vi.fn(async () => ({ code: 1, tempC: 20 }));
    const context = makeRadioDjContext({
      explicitLikes: () => [],
      fetchWeather: async (latitude, longitude) => {
        await ensureCurrentProcessingAuthorized({
          operationKey: `proactive:weather:${latitude}:${longitude}`,
          workload: "network_tool",
          provider: "openmeteo",
          model: "weather",
          endpointUrl: "https://api.open-meteo.com",
          endpointZone: "unverified",
          requiresConsent: true,
        });
        return networkFetch();
      },
    });
    const snapshot = await context.snapshot({
      sessionId: "s1", idleMs: 1, djIntervalMs: 1, timezone: "Asia/Seoul",
      weatherLocation: { latitude: 37, longitude: 127, consented: true },
      bgmAutoPlayOptIn: false,
    });
    expect(networkFetch).not.toHaveBeenCalled();
    expect(snapshot.weather).toBeUndefined();
  });

  it("fails closed before provider call when background work has no request context", async () => {
    const called = vi.fn();
    const delegate: ProviderPort = {
      async *chat() { called(); yield { kind: "finish" }; },
    };
    const guarded = makeProcessingAwareProvider(delegate, trusted);
    await expect(drain(guarded.chat(config, [], {})))
      .rejects.toThrow("PROCESSING_REQUEST_CONTEXT_REQUIRED");
    expect(called).not.toHaveBeenCalled();
  });

  it("declares trusted main_llm metadata immediately before the delegate call", async () => {
    const order: string[] = [];
    const authorize = vi.fn(async (operation) => {
      order.push("authorize");
      expect(operation).toMatchObject({
        operationKey: "round:1",
        workload: "main_llm",
        provider: "openai",
        model: "gpt-5",
        ...trusted,
      });
    });
    const delegate: ProviderPort = {
      async *chat() { order.push("provider"); yield { kind: "finish" }; },
    };
    const context = makeProcessingRequestContext(authorize);
    const guarded = makeProcessingAwareProvider(delegate, trusted);
    await runWithProcessingRequestContext(context, () =>
      drain(guarded.chat(config, [], { processingOperationKey: "round:1" })));
    expect(order).toEqual(["authorize", "provider"]);
  });

  it("makes zero provider calls when authorization rejects", async () => {
    const called = vi.fn();
    const delegate: ProviderPort = {
      async *chat() { called(); yield { kind: "finish" }; },
    };
    const context = makeProcessingRequestContext(async () => {
      throw new Error("EXTERNAL_PROCESSING_FORBIDDEN");
    });
    const guarded = makeProcessingAwareProvider(delegate, trusted);
    await expect(runWithProcessingRequestContext(context, () =>
      drain(guarded.chat(config, [], {})))).rejects.toThrow("EXTERNAL_PROCESSING_FORBIDDEN");
    expect(called).not.toHaveBeenCalled();
  });

  it("does not disclose local tools and guards a network tool at execute boundary", async () => {
    const execute = vi.fn(async () => ({ output: "ok" }));
    const delegate = {
      specs: () => [],
      execute,
    };
    const guarded = makeProcessingAwareToolExecutor(delegate, (call) =>
      call.name === "weather" ? {
        operationKey: `tool:${call.id}`,
        workload: "network_tool",
        provider: "openmeteo",
        model: "weather",
        endpointUrl: "https://api.open-meteo.com",
        endpointZone: "unverified",
        requiresConsent: true,
      } : undefined);
    await guarded.execute({ id: "1", name: "local_memo", args: {} }, {});
    const authorize = vi.fn(async (_operation: ProcessingOperation) => {});
    const context = makeProcessingRequestContext(authorize);
    await runWithProcessingRequestContext(context, () =>
      guarded.execute({ id: "2", name: "weather", args: {} }, {}));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({ workload: "network_tool" });
  });

  it("authorizes every actual external embedding delegate call", async () => {
    const delegate = {
      dims: 2,
      name: "remote",
      embed: vi.fn(async (_text: string) => [1, 2]),
      embedBatch: vi.fn(async (_texts: string[]) => [[1, 2]]),
    };
    const guarded = makeProcessingAwareEmbedding(delegate, {
      provider: "vllm",
      model: "embed",
      endpointUrl: "https://embed.example.com",
      endpointZone: "unverified",
      requiresConsent: true,
    });
    const authorize = vi.fn(async (_operation: ProcessingOperation) => {});
    const context = makeProcessingRequestContext(authorize);
    await runWithProcessingRequestContext(context, async () => {
      await guarded.embed("a");
      await guarded.embedBatch(["b"]);
    });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls.map(([operation]) => operation.operationKey)).toEqual([
      "embedding:call:1", "embedding:call:2",
    ]);
    expect(delegate.embed).toHaveBeenCalledOnce();
    expect(delegate.embedBatch).toHaveBeenCalledOnce();
  });

  it("authorizes each provider round and never embeds slash-bearing model text in operation keys", async () => {
    const delegate: ProviderPort = {
      async *chat() { yield { kind: "finish" }; },
    };
    const guarded = makeProcessingAwareProvider(delegate, trusted);
    const authorize = vi.fn(async (_operation: ProcessingOperation) => {});
    const context = makeProcessingRequestContext(authorize);
    await runWithProcessingRequestContext(context, async () => {
      await drain(guarded.chat({ provider: "openai", model: "org/model" }, [], {}));
      await drain(guarded.chat({ provider: "openai", model: "org/model" }, [], {}));
    });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize.mock.calls.map(([operation]) => operation.operationKey)).toEqual([
      "main_llm:call:1", "main_llm:call:2",
    ]);
  });

  it.each(["fact_extractor", "summarizer", "contradiction_filter"] as const)(
    "guards memory %s immediately before its delegate",
    async (purpose) => {
      const order: string[] = [];
      const guarded = makeProcessingAwareMemoryLlm(
        async (_input: string) => { order.push("delegate"); return "ok"; },
        {
          purpose,
          provider: "naia",
          model: "memory-small",
          endpointUrl: "https://api.nextain.io",
          endpointZone: "unverified",
          requiresConsent: true,
        },
      );
      const authorize = vi.fn(async (operation: ProcessingOperation) => {
        order.push("authorize");
        expect(operation).toMatchObject({ workload: "memory_llm", provider: "naia", model: "memory-small" });
      });
      await expect(runWithProcessingRequestContext(
        makeProcessingRequestContext(authorize),
        () => guarded("input"),
      )).resolves.toBe("ok");
      expect(order).toEqual(["authorize", "delegate"]);
    },
  );
});
