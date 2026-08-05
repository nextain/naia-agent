import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGatewayRequestBudget,
  initializeNaiaPiReceiptJournal,
  makeNaiaVersionedBillingFetch,
  readGatewayRequestBudget,
  readGatewayRequestBudgetEvidence,
  readNaiaPiReceiptJournal,
} from "../main/adapters/naia-pi-versioned-billing.js";
import { makeCumulativePiLineParser } from "../main/adapters/subagent-pi.js";

const EXECUTION = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
const tempJournal = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "naia-pi-billing-"));
  dirs.push(dir);
  const path = join(dir, "receipt.json");
  initializeNaiaPiReceiptJournal(path, EXECUTION);
  return path;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function completion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatcmpl-1", object: "chat.completion", created: 1, model: "grok-4.3",
    choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 5 } },
    customer_cost: "0.00001234", price_version_id: "price-v1", currency: "USD",
    settlement_status: "settled", billing_status: "settled",
    gateway_request_id: `naia-pi-${EXECUTION}-1`, gateway_attempt: 1,
    ...overrides,
  };
}

function requestBody(): string {
  return JSON.stringify({ model: "grok-4.3", messages: [{ role: "user", content: "fix" }],
    stream: true, stream_options: { include_usage: true } });
}

function billingFetch(journalPath: string, delegate: typeof fetch): typeof fetch {
  const path = join(dirname(journalPath), "default-gateway.db");
  const policy = { maxGatewayCalls: 20, maxUsd: 1, maxInputTokens: 80_000, maxOutputTokens: 10_000,
    requestAllowance: { reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 500 } };
  initializeGatewayRequestBudget(path, policy);
  return makeNaiaVersionedBillingFetch({ executionId: EXECUTION, journalPath, delegate,
    gatewayBudget: { path, policy } });
}

describe("FR-LOOP-008 Naia Pi atomic versioned billing bridge", () => {
  it("sends a bound non-stream request, persists exact settlement, and reconstructs SSE", async () => {
    const journalPath = tempJournal();
    let outbound: Record<string, unknown> | undefined;
    const delegate: typeof fetch = async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(completion()), { status: 200, headers: { "x-provider": "gateway" } });
    };
    const bridged = billingFetch(journalPath, delegate);
    const response = await bridged("https://gateway.example/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: requestBody(),
    });

    expect(outbound).toMatchObject({ model: "grok-4.3", stream: false,
      gateway_request_id: `naia-pi-${EXECUTION}-1`, gateway_attempt: 1 });
    expect(outbound).not.toHaveProperty("stream_options");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"done"');
    expect(text).toContain("data: [DONE]");

    const journal = readNaiaPiReceiptJournal(journalPath, EXECUTION);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]?.receipt).toMatchObject({
      source: "gateway_versioned_customer_billing", executionId: EXECUTION,
      localRequestId: `${EXECUTION}:call:1`, gatewayRequestId: `naia-pi-${EXECUTION}-1`,
      provider: "naia", model: "grok-4.3", responseModel: "grok-4.3",
      inputTokens: 7, cachedInputTokens: 5, outputTokens: 4, totalTokens: 16,
      customerCostDecimal: "0.00001234", customerCostUsd: 0.00001234,
      priceVersionId: "price-v1", settlementStatus: "settled",
    });
  });

  it("preserves tool calls in the reconstructed OpenAI chunk", async () => {
    const journalPath = tempJournal();
    const payload = completion({
      choices: [{ index: 0, message: { role: "assistant", content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }] },
      finish_reason: "tool_calls" }],
    });
    const delegate: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
    const response = await billingFetch(journalPath, delegate)(
      "https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    expect(await response.text()).toContain('"tool_calls":[{"id":"call-1"');
  });

  it("reuses a logical gateway identity across transport retry and journals only settled success", async () => {
    const journalPath = tempJournal();
    const sent: Array<Record<string, unknown>> = [];
    const delegate: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (sent.length === 1) return new Response('{"error":"retry"}', { status: 503 });
      return new Response(JSON.stringify(completion({ gateway_attempt: 2 })), { status: 200 });
    };
    const bridged = billingFetch(journalPath, delegate);
    const first = await bridged("https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    expect(first.status).toBe(503);
    await bridged("https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    expect(sent.map((item) => item.gateway_request_id)).toEqual([
      `naia-pi-${EXECUTION}-1`, `naia-pi-${EXECUTION}-1`,
    ]);
    expect(sent.map((item) => item.gateway_attempt)).toEqual([1, 2]);
    expect(readNaiaPiReceiptJournal(journalPath).entries).toHaveLength(1);
  });

  it.each([
    ["unsettled", { settlement_status: "settlement_pending", billing_status: "settlement_pending" }],
    ["request mismatch", { gateway_request_id: "foreign" }],
    ["response model drift", { model: "fallback-model" }],
    ["missing price", { price_version_id: "" }],
    ["token mismatch", { usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 5 } }],
  ])("fails closed on %s gateway evidence", async (_name, overrides) => {
    const journalPath = tempJournal();
    const delegate: typeof fetch = async () => new Response(JSON.stringify(completion(overrides)), { status: 200 });
    await expect(billingFetch(journalPath, delegate)(
      "https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() })).rejects.toThrow();
    expect(readNaiaPiReceiptJournal(journalPath).entries).toHaveLength(0);
  });

  it("detects journal tampering and refuses measured parent evidence", async () => {
    const journalPath = tempJournal();
    const delegate: typeof fetch = async () => new Response(JSON.stringify(completion()), { status: 200 });
    await billingFetch(journalPath, delegate)(
      "https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    const raw = readFileSync(journalPath, "utf8").replace("0.00001234", "0.10000000");
    writeFileSync(journalPath, raw, "utf8");
    expect(() => readNaiaPiReceiptJournal(journalPath, EXECUTION)).toThrow(/digest mismatch|amount or route invalid/u);

    const parse = makeCumulativePiLineParser({ provider: "naia", model: "grok-4.3" },
      { sessionId: "session", executionId: EXECUTION }, journalPath);
    const events = parse(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "naia",
      model: "grok-4.3", content: [], usage: { input: 7, cacheRead: 5, output: 4, totalTokens: 16 } } }));
    expect(events.at(-1)).toMatchObject({ kind: "session_end", ok: false,
      reason: expect.stringContaining("billing receipt unavailable") });
    expect(events.some((event) => event.kind === "model_evidence" && event.evidence.measuredCostUsd !== undefined)).toBe(false);
  });

  it("binds ordered journal rows to cumulative Pi usage and measured cost", async () => {
    const journalPath = tempJournal();
    const delegate: typeof fetch = async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as { gateway_request_id: string; gateway_attempt: number };
      const index = sent.gateway_request_id.endsWith("-1") ? 1 : 2;
      return new Response(JSON.stringify(completion({
        gateway_request_id: sent.gateway_request_id, gateway_attempt: sent.gateway_attempt,
        customer_cost: index === 1 ? "0.00001234" : "0.00002000",
        usage: { prompt_tokens: index === 1 ? 12 : 8, completion_tokens: index === 1 ? 4 : 2,
          total_tokens: index === 1 ? 16 : 10, prompt_tokens_details: { cached_tokens: index === 1 ? 5 : 0 } },
      })), { status: 200 });
    };
    const bridged = billingFetch(journalPath, delegate);
    await bridged("https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    const parse = makeCumulativePiLineParser({ provider: "naia", model: "grok-4.3" },
      { sessionId: "session", executionId: EXECUTION }, journalPath);
    const first = parse(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "naia",
      model: "grok-4.3", content: [], usage: { input: 7, cacheRead: 5, output: 4, totalTokens: 16 } } }));
    expect(first[0]).toMatchObject({ kind: "model_evidence", evidence: { measuredCostUsd: 0.00001234 } });

    await bridged("https://gateway.example/v1/chat/completions", { method: "POST",
      body: JSON.stringify({ model: "grok-4.3", messages: [{ role: "tool", content: "next" }], stream: true }) });
    const second = parse(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "naia",
      model: "grok-4.3", content: [], usage: { input: 8, output: 2, totalTokens: 10 } } }));
    expect(second[0]).toMatchObject({ kind: "model_evidence", evidence: {
      inputTokens: 15, cachedInputTokens: 5, outputTokens: 6, totalTokens: 26,
      measuredCostUsd: 0.00003234, gatewayBillingReceipts: expect.arrayContaining([
        expect.objectContaining({ localRequestId: `${EXECUTION}:call:1` }),
        expect.objectContaining({ localRequestId: `${EXECUTION}:call:2` }),
      ]),
    } });
  });

  it("reserves each logical gateway request before fetch and blocks the next call at the durable cap", async () => {
    const journalPath = tempJournal(); const budgetPath = join(dirname(journalPath), "gateway.db");
    const policy = { maxGatewayCalls: 1, maxUsd: 0.025, maxInputTokens: 4_000, maxOutputTokens: 500,
      requestAllowance: { reservedUsd: 0.025, reservedInputTokens: 4_000, reservedOutputTokens: 500 } };
    initializeGatewayRequestBudget(budgetPath, policy);
    let effects = 0;
    const delegate: typeof fetch = async (_input, init) => {
      effects += 1; const sent = JSON.parse(String(init?.body)) as { gateway_request_id: string; gateway_attempt: number };
      return new Response(JSON.stringify(completion({ gateway_request_id: sent.gateway_request_id,
        gateway_attempt: sent.gateway_attempt })), { status: 200 });
    };
    const bridged = makeNaiaVersionedBillingFetch({ executionId: EXECUTION, journalPath, delegate,
      gatewayBudget: { path: budgetPath, policy } });
    await bridged("https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    await expect(bridged("https://gateway.example/v1/chat/completions", { method: "POST",
      body: JSON.stringify({ model: "grok-4.3", messages: [{ role: "user", content: "second" }] }) }))
      .rejects.toThrow(/pre-call budget/u);
    expect(effects).toBe(1);
    expect(readGatewayRequestBudget(budgetPath, policy)).toMatchObject({ gatewayCalls: 1,
      activeReservations: 0, chargedUsd: 0.00001234, chargedInputTokens: 12, chargedOutputTokens: 4 });
    expect(readGatewayRequestBudgetEvidence(budgetPath, policy)).toMatchObject({
      rows: [{ requestId: `naia-pi-${EXECUTION}-1`, status: "settled", actualCostDecimal: "0.00001234",
        actualInputTokens: 12, actualOutputTokens: 4, receiptDigest: expect.stringMatching(/^sha256:/u) }],
      snapshot: { gatewayCalls: 1, activeReservations: 0, chargedUsdDecimal: "0.00001234" },
    });
  });

  it("retains the exact paid receipt when actual usage exceeds its conservative reservation", async () => {
    const journalPath = tempJournal(); const budgetPath = join(dirname(journalPath), "gateway.db");
    const policy = { maxGatewayCalls: 1, maxUsd: 0.025, maxInputTokens: 4_000, maxOutputTokens: 500,
      requestAllowance: { reservedUsd: 0.00001, reservedInputTokens: 10, reservedOutputTokens: 3 } };
    initializeGatewayRequestBudget(budgetPath, policy);
    let effects = 0;
    const delegate: typeof fetch = async () => { effects += 1;
      return new Response(JSON.stringify(completion()), { status: 200 }); };
    const bridged = makeNaiaVersionedBillingFetch({ executionId: EXECUTION, journalPath, delegate,
      gatewayBudget: { path: budgetPath, policy } });
    await expect(bridged("https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() }))
      .rejects.toThrow(/exceeded its durable reservation/u);
    expect(readNaiaPiReceiptJournal(journalPath).entries).toHaveLength(1);
    expect(readGatewayRequestBudget(budgetPath, policy)).toMatchObject({ gatewayCalls: 1,
      activeReservations: 0, chargedUsd: 0.00001234, chargedInputTokens: 12, chargedOutputTokens: 4 });
    await expect(bridged("https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() }))
      .rejects.toThrow(/already settled/u);
    expect(effects).toBe(1);
  });

  it("is consumed by the exact Pi OpenAI completion API across a tool turn and final turn", async () => {
    const journalPath = tempJournal(); let turn = 0;
    const delegate: typeof fetch = async (_input, init) => {
      turn += 1; const sent = JSON.parse(String(init?.body)) as { gateway_request_id: string; gateway_attempt: number };
      const payload = turn === 1 ? completion({ gateway_request_id: sent.gateway_request_id,
        choices: [{ index: 0, message: { role: "assistant", content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }] },
        finish_reason: "tool_calls" }] }) : completion({ gateway_request_id: sent.gateway_request_id,
          choices: [{ index: 0, message: { role: "assistant", content: "finished" }, finish_reason: "stop" }] });
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const bridged = billingFetch(journalPath, delegate);
    const piAgentEntry = realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
    const apiUrl = pathToFileURL(realpathSync(join(dirname(dirname(piAgentEntry)),
      "../pi-ai/dist/api/openai-completions.lazy.js"))).href;
    const { openAICompletionsApi } = await import(apiUrl) as { openAICompletionsApi(): any };
    const api = openAICompletionsApi();
    const model = { id: "grok-4.3", name: "Grok", api: "openai-completions", provider: "naia",
      baseUrl: "https://gateway.example/v1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 500 };
    const options = { apiKey: "test", fetch: bridged, maxRetries: 0 };
    const first = await api.streamSimple(model, { messages: [{ role: "user", content: "read x", timestamp: 1 }],
      tools: [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }, options).result();
    expect(first.stopReason).toBe("toolUse");
    expect(first.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "toolCall", name: "read",
      arguments: { path: "x" } })]));
    const second = await api.streamSimple(model, { messages: [{ role: "user", content: "continue", timestamp: 2 }] }, options).result();
    expect(second).toMatchObject({ stopReason: "stop", content: [expect.objectContaining({ type: "text", text: "finished" })] });
    expect(readNaiaPiReceiptJournal(journalPath).entries.map((entry) => entry.receipt.localRequestId))
      .toEqual([`${EXECUTION}:call:1`, `${EXECUTION}:call:2`]);
  });
});
