import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";
import { makeOpenAICompatProvider } from "../main/adapters/openai-compat-provider.js";
import { emitToProto } from "../main/adapters/grpc/grpc-codec.js";
import { encodeEmit } from "../main/adapters/protocol.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import type { AgentEmit, BillingReceipt, ChatRequest, ProviderChunk } from "../main/domain/chat.js";
import type { ProviderPort } from "../main/ports/uc1.js";

type UsageChunk = Extract<ProviderChunk, { kind: "usage" }>;
type UsageEmit = Extract<AgentEmit, { kind: "usage" }>;

function receipt(requestId: string, customerCost: string, attempt = 1): BillingReceipt {
  return { requestId, attempt, priceVersionId: "pv-1", currency: "USD", customerCost, status: "settled" };
}

function jsonBody(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let sent = false;
  return { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
    cancel() {},
  }) };
}

function gatewayPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-response-1", object: "chat.completion", model: "gemini-3.6-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    customer_cost: "0.01050000", price_version_id: "pv-1", currency: "USD",
    settlement_status: "settled", gateway_request_id: "gw-round-1", gateway_attempt: 1,
    billing_status: "settled",
    ...overrides,
  };
}

async function runHandler(provider: ProviderPort, providerName = "nextain", toolExecutor?: HandlerDeps["toolExecutor"]): Promise<AgentEmit[]> {
  const emitted: AgentEmit[] = [];
  const deps: HandlerDeps = {
    provider,
    conversation: { assemble: (request) => ({ messages: request.messages }) },
    credentials: { update() {}, get() { return undefined; } },
    approval: { resolve() {}, prepareDecision() { return { promise: Promise.resolve("approve" as const), dispose() {} }; } },
    egress: { emit: (_requestId, event) => emitted.push(event) }, diag: { log() {} },
    ...(toolExecutor ? { toolExecutor } : {}),
  };
  const request: ChatRequest = { kind: "chat", requestId: "turn-1", provider: { provider: providerName, model: "gemini-3.6-flash" }, messages: [{ role: "user", content: "hello" }] };
  await new ChatTurnHandler(deps).onChatRequest(request);
  return emitted;
}

function usageOf(events: readonly AgentEmit[]): UsageEmit {
  return events.find((event): event is UsageEmit => event.kind === "usage")!;
}

describe("UC-GATEWAY-COST — real non-stream versioned billing contract", () => {
  it("sends non-stream round binding and parses the seven top-level snake_case billing fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = makeOpenAICompatProvider({ baseUrl: "https://gateway.invalid/v1", apiKey: "key", auth: "x-anyllm", fetch: (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, statusText: "OK", body: jsonBody(gatewayPayload()) };
    }) as never });
    const chunks: ProviderChunk[] = [];
    for await (const chunk of provider.chat({ provider: "nextain", model: "gemini-3.6-flash" }, [{ role: "user", content: "hello" }], { gatewayRequestId: "gw-round-1", gatewayAttempt: 1 })) chunks.push(chunk);

    expect(bodies).toEqual([expect.objectContaining({
      stream: false,
      max_tokens: 16000,
      gateway_request_id: "gw-round-1",
      gateway_attempt: 1,
    })]);
    expect(chunks).toEqual([
      { kind: "text", text: "hello" },
      { kind: "usage", inputTokens: 0, outputTokens: 0, billingReceipt: receipt("gw-round-1", "0.01050000") },
      { kind: "finish" },
    ]);
  });

  it("retries one pre-response transport rejection with the same request ID and an increased attempt", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const provider = makeOpenAICompatProvider({ baseUrl: "https://gateway.invalid/v1", apiKey: "key", auth: "x-anyllm", fetch: (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body)); call++;
      if (call === 1) throw new TypeError("fetch failed: connection reset before response");
      return { ok: true, status: 200, statusText: "OK", body: jsonBody(gatewayPayload({ gateway_attempt: 2 })) };
    }) as never });
    const chunks: ProviderChunk[] = [];
    for await (const chunk of provider.chat({ provider: "nextain", model: "m" }, [], { gatewayRequestId: "gw-round-1", gatewayAttempt: 1 })) chunks.push(chunk);
    expect(bodies.map((body) => [body.gateway_request_id, body.gateway_attempt])).toEqual([["gw-round-1", 1], ["gw-round-1", 2]]);
    expect((chunks.find((chunk) => chunk.kind === "usage") as UsageChunk).billingReceipt?.attempt).toBe(2);
  });

  it("does not retry an HTTP 5xx response", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = makeOpenAICompatProvider({ baseUrl: "https://gateway.invalid/v1", apiKey: "key", auth: "x-anyllm", fetch: (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: false, status: 503, statusText: "upstream unavailable", body: jsonBody({ detail: "do not retry" }) };
    }) as never });
    await expect(async () => {
      for await (const _chunk of provider.chat({ provider: "nextain", model: "m" }, [], { gatewayRequestId: "gw-round-1", gatewayAttempt: 1 })) { /* drain */ }
    }).rejects.toThrow("503 upstream unavailable");
    expect(bodies.map((body) => [body.gateway_request_id, body.gateway_attempt])).toEqual([["gw-round-1", 1]]);
  });

  it("preserves distinct round receipts and sums their exact totals", async () => {
    let round = 0;
    const provider: ProviderPort = { async *chat(_config, _messages, opts) {
      round++;
      expect(opts.gatewayRequestId).toBe(`turn-1:round:${round}`);
      if (round === 1) yield { kind: "toolUse", id: "tool-1", name: "noop", args: {} };
      yield { kind: "usage", inputTokens: round, outputTokens: round, billingReceipt: receipt(opts.gatewayRequestId!, round === 1 ? "0.10000001" : "0.20000009") };
      yield { kind: "finish" };
    } };
    const events = await runHandler(provider, "nextain", { specs: () => [{ name: "noop", description: "noop", parameters: { type: "object" }, tier: "none" }], execute: async () => ({ output: "ok" }) });
    expect(usageOf(events)).toMatchObject({ customerCost: "0.30000010", billingStatus: "confirmed", billingReceipts: [receipt("turn-1:round:1", "0.10000001"), receipt("turn-1:round:2", "0.20000009")] });
    expect(events.at(-1)?.kind).toBe("finish");
  });

  it.each([
    ["missing receipt", undefined],
    ["duplicate request ID across rounds", receipt("turn-1:round:1", "0.2")],
    ["whitespace request ID", receipt("   ", "0.2")],
    ["version mismatch", { ...receipt("turn-1:round:2", "0.2"), priceVersionId: "pv-2" }],
  ] as const)("fails hosted success for %s", async (_name, secondReceipt) => {
    let round = 0;
    const provider: ProviderPort = { async *chat() {
      round++;
      if (round === 1) yield { kind: "toolUse", id: "tool-1", name: "noop", args: {} };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1, ...(round === 1 ? { billingReceipt: receipt("turn-1:round:1", "0.1") } : secondReceipt ? { billingReceipt: secondReceipt } : {}) };
      yield { kind: "finish" };
    } };
    const events = await runHandler(provider, "nextain", { specs: () => [{ name: "noop", description: "noop", parameters: { type: "object" }, tier: "none" }], execute: async () => ({ output: "ok" }) });
    expect(events.some((event) => event.kind === "finish")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "error", code: "BILLING_INTEGRITY" });
  });

  it("keeps BYO streaming estimates separate", async () => {
    const provider: ProviderPort = { async *chat() { yield { kind: "usage", inputTokens: 1_000_000, outputTokens: 1_000_000 }; yield { kind: "finish" }; } };
    expect(usageOf(await runHandler(provider, "gemini"))).toMatchObject({ billingStatus: "estimated" });
  });

  it("round-trips receipt arrays through stdio and actual protobuf serialization", () => {
    const event = { kind: "usage", inputTokens: 3, outputTokens: 4, cost: 0.3, customerCost: "0.30000000", billingStatus: "confirmed", billingReceipts: [receipt("gw-1", "0.1"), receipt("gw-2", "0.2")], model: "m" } satisfies UsageEmit;
    expect(encodeEmit("turn-1", event)).toMatchObject({ customerCost: "0.30000000", billingReceipts: event.billingReceipts });
    const protoPath = resolve(dirname(fileURLToPath(import.meta.url)), "../main/adapters/grpc/naia_agent.proto");
    const definition = protoLoader.loadSync(protoPath, { keepCase: false, longs: Number, enums: String, defaults: false, oneofs: true });
    const message = definition["naia.agent.v1.AgentEvent"] as unknown as { serialize(value: unknown): Buffer; deserialize(bytes: Buffer): unknown };
    const decoded = message.deserialize(message.serialize(emitToProto("turn-1", event))) as { usage: Record<string, unknown> };
    expect(decoded.usage).toMatchObject({ customerCost: "0.30000000", billingReceipts: [{ requestId: "gw-1", customerCost: "0.1" }, { requestId: "gw-2", customerCost: "0.2" }] });
  });
});
