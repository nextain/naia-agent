import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  convertResponsesToChatCompletionsRequest,
  initializeGatewayRequestBudget,
  initializeNaiaPiReceiptJournal,
  makeNaiaVersionedBillingFetch,
  readGatewayRequestBudget,
  readGatewayRequestBudgetEvidence,
  readNaiaPiReceiptJournal,
  startCodexResponsesLoopbackBridge,
  stripToolsFromPayload,
} from "../main/adapters/naia-pi-versioned-billing.js";

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

describe("FR-LOOP-008 Naia atomic versioned billing bridge and Codex /v1/responses loopback", () => {
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

  it("detects journal tampering and refuses corrupted digest chains", async () => {
    const journalPath = tempJournal();
    const delegate: typeof fetch = async () => new Response(JSON.stringify(completion()), { status: 200 });
    await billingFetch(journalPath, delegate)(
      "https://gateway.example/v1/chat/completions", { method: "POST", body: requestBody() });
    const raw = readFileSync(journalPath, "utf8").replace("0.00001234", "0.10000000");
    writeFileSync(journalPath, raw, "utf8");
    expect(() => readNaiaPiReceiptJournal(journalPath, EXECUTION)).toThrow(/digest mismatch|amount or route invalid/u);
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

  it("strips tools/tool_choice/parallel_tool_calls/additional_tools when noTools is enabled and preserves reasoning_content across tool turns", () => {
    const stripped = stripToolsFromPayload({
      model: "deepseek-v4-flash",
      tools: [{ type: "function", name: "exec_command" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      additional_tools: ["update_plan"],
      input: [{ role: "user", content: "hello" }],
    });
    expect(stripped).not.toHaveProperty("tools");
    expect(stripped).not.toHaveProperty("tool_choice");
    expect(stripped).not.toHaveProperty("parallel_tool_calls");
    expect(stripped).not.toHaveProperty("additional_tools");

    const reasoningCache = new Map<string, string>([["call-42", "step-by-step reasoning"]]);
    const converted = convertResponsesToChatCompletionsRequest({
      model: "motif-3",
      instructions: "be concise",
      max_output_tokens: 8192,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect file" }] },
        { type: "function_call", call_id: "call-42", name: "exec_command", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call-42", output: "README.md" },
      ],
      tools: [{ type: "function", name: "exec_command", description: "run cmd", parameters: { type: "object" } }],
      tool_choice: "auto",
    }, { expectedModel: "motif-3", noTools: true, maxOutputTokens: 8192, reasoningByCallId: reasoningCache });

    expect(converted).not.toHaveProperty("tools");
    expect(converted).not.toHaveProperty("tool_choice");
    expect(converted.max_tokens).toBe(8192);
    const messages = converted.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "be concise" });
    expect(messages[1]).toEqual({ role: "user", content: "inspect file" });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      reasoning_content: "step-by-step reasoning",
      tool_calls: [{ id: "call-42", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call-42", content: "README.md" });
  });

  it("bridges Codex /v1/responses over loopback HTTP to Naia /v1/chat/completions with billing receipts, bridgeToken auth, and noTools stripping", async () => {
    const journalPath = tempJournal();
    const budgetPath = join(dirname(journalPath), "bridge-gateway.db");
    const policy = { maxGatewayCalls: 4, maxUsd: 0.2, maxInputTokens: 16_000, maxOutputTokens: 2_000,
      requestAllowance: { reservedUsd: 0.05, reservedInputTokens: 4_000, reservedOutputTokens: 500 } };
    initializeGatewayRequestBudget(budgetPath, policy);

    const upstreamCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const delegate: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamCalls.push({
        url: String(input),
        headers: {
          "x-anyllm-key": headers.get("x-anyllm-key") ?? "",
          authorization: headers.get("authorization") ?? "",
        },
        body,
      });
      return new Response(JSON.stringify(completion({
        model: "deepseek-v4-flash",
        gateway_request_id: body.gateway_request_id,
        gateway_attempt: body.gateway_attempt,
        choices: [{ index: 0, message: { role: "assistant", content: "bridged-answer", reasoning_content: "thought-1" }, finish_reason: "stop" }],
      })), { status: 200 });
    };

    const bridgeToken = "test-bridge-token-123";
    const bridge = await startCodexResponsesLoopbackBridge({
      provider: "naia",
      upstreamBaseUrl: "https://gateway.example/v1",
      expectedModel: "deepseek-v4-flash",
      bridgeToken,
      noTools: true,
      maxOutputTokens: 8192,
      getApiKey: () => "live-naia-key",
      billing: {
        executionId: EXECUTION,
        journalPath,
        gatewayBudget: { path: budgetPath, policy },
      },
      fetch: delegate,
    });

    try {
      expect(bridge.port).toBeGreaterThan(0);
      const unauth = await fetch(`${bridge.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
        body: JSON.stringify({ model: "deepseek-v4-flash", input: "hi" }),
      });
      expect(unauth.status).toBe(401);

      const res = await fetch(`${bridge.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "summarize" }] }],
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
          tool_choice: "auto",
          parallel_tool_calls: true,
        }),
      });
      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).toContain("event: response.created");
      expect(sse).toContain("event: response.completed");
      expect(sse).toContain("bridged-answer");

      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]?.url).toBe("https://gateway.example/v1/chat/completions");
      expect(upstreamCalls[0]?.headers["x-anyllm-key"]).toBe("Bearer live-naia-key");
      expect(upstreamCalls[0]?.headers.authorization).toBe("");
      expect(upstreamCalls[0]?.body).not.toHaveProperty("tools");
      expect(upstreamCalls[0]?.body).not.toHaveProperty("tool_choice");
      expect(upstreamCalls[0]?.body).not.toHaveProperty("parallel_tool_calls");

      expect(bridge.turns).toEqual([
        expect.objectContaining({
          requestModel: "deepseek-v4-flash",
          responseModel: "deepseek-v4-flash",
          inputTokens: 7,
          cachedInputTokens: 5,
          outputTokens: 4,
          totalTokens: 16,
        }),
      ]);
      expect(readNaiaPiReceiptJournal(journalPath, EXECUTION).entries).toHaveLength(1);
    } finally {
      bridge.close();
    }
  });

  it("binds loopback bridge via public server.listen without _listen2 and fails closed when port is 0 or invalid (P2-라)", async () => {
    const { EventEmitter } = await import("node:events");
    let listenCalledWith: unknown[] = [];
    let closedCount = 0;

    // 1) Public server.listen async binding succeeds even when private _listen2 does not exist
    const emitterOk = new EventEmitter();
    const fakeServerOk = Object.assign(emitterOk, {
      listen(...args: unknown[]) {
        listenCalledWith = args;
        queueMicrotask(() => emitterOk.emit("listening"));
        return fakeServerOk;
      },
      unref() {},
      address() { return { address: "127.0.0.1", family: "IPv4", port: 43210 }; },
      close() { closedCount += 1; },
    });
    const handle = await startCodexResponsesLoopbackBridge({
      provider: "local",
      expectedModel: "qwen",
      upstreamBaseUrl: "http://127.0.0.1:11434/v1",
      createServerFn: (() => fakeServerOk) as any,
    });
    expect(listenCalledWith).toEqual([0, "127.0.0.1"]);
    expect(handle.port).toBe(43210);
    expect(handle.baseUrl).toBe("http://127.0.0.1:43210/v1");
    handle.close();
    expect(closedCount).toBe(1);

    // 2) Fails closed if server.address() returns port 0
    const emitterZero = new EventEmitter();
    const fakeServerZeroPort = Object.assign(emitterZero, {
      listen() {
        queueMicrotask(() => emitterZero.emit("listening"));
        return fakeServerZeroPort;
      },
      unref() {},
      address() { return { address: "127.0.0.1", family: "IPv4", port: 0 }; },
      close() { closedCount += 1; },
    });
    await expect(startCodexResponsesLoopbackBridge({
      provider: "local",
      expectedModel: "qwen",
      upstreamBaseUrl: "http://127.0.0.1:11434/v1",
      createServerFn: (() => fakeServerZeroPort) as any,
    })).rejects.toThrow("Codex loopback bridge failed to bind a valid loopback port");
    expect(closedCount).toBe(2);
  });
});
