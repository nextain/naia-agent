// UC-ORCH-004 / FR-LOOP-008 — request-correlated atomic gateway billing and Codex Responses loopback bridge.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { GatewayBillingReceipt } from "../domain/orchestration.js";

export interface NaiaPiGatewayBillingReceipt extends GatewayBillingReceipt {
  readonly source: "gateway_versioned_customer_billing";
  readonly executionId: string;
  readonly localRequestId: string;
  readonly gatewayRequestId: string;
  readonly gatewayAttempt: number;
  readonly provider: "naia";
  readonly model: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly customerCostDecimal: string;
  readonly customerCostUsd: number;
  readonly priceVersionId: string;
  readonly currency: string;
  readonly settlementStatus: "settled";
}

interface JournalEntry {
  readonly receipt: NaiaPiGatewayBillingReceipt;
  readonly previousDigest: string;
  readonly digest: string;
}

export interface NaiaPiReceiptJournal {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly headDigest: string;
  readonly entries: readonly JournalEntry[];
}

export interface VersionedBillingFetchOptions {
  readonly executionId: string;
  readonly journalPath: string;
  readonly gatewayBudget: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy };
  readonly delegate?: typeof globalThis.fetch;
}

export interface GatewayRequestBudgetPolicy {
  readonly maxGatewayCalls: number;
  readonly maxUsd: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly requestAllowance: { readonly reservedUsd: number; readonly reservedInputTokens: number; readonly reservedOutputTokens: number };
}

export interface GatewayRequestBudgetSnapshot {
  readonly gatewayCalls: number;
  readonly activeReservations: number;
  readonly chargedUsd: number;
  readonly chargedInputTokens: number;
  readonly chargedOutputTokens: number;
}

export interface GatewayRequestBudgetEvidenceRow {
  readonly requestId: string;
  readonly status: "active" | "settled";
  readonly actualCostDecimal?: string;
  readonly actualInputTokens?: number;
  readonly actualOutputTokens?: number;
  readonly receiptDigest?: string;
}

export interface GatewayRequestBudgetEvidence {
  readonly rows: readonly GatewayRequestBudgetEvidenceRow[];
  readonly snapshot: GatewayRequestBudgetSnapshot & { readonly chargedUsdDecimal: string };
}

export interface CodexBridgeTurnRecord {
  readonly requestModel: string;
  readonly responseModel: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly receipt?: NaiaPiGatewayBillingReceipt;
}

export interface CodexResponsesBridgeOptions {
  readonly provider: string;
  readonly expectedModel: string;
  readonly upstreamBaseUrl: string;
  readonly bridgeToken?: string;
  readonly getApiKey?: () => string | undefined;
  readonly noTools?: boolean;
  readonly maxOutputTokens?: number;
  readonly thinkingLevel?: string;
  readonly billing?: {
    readonly executionId: string;
    readonly journalPath: string;
    readonly gatewayBudget: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy };
  };
  readonly fetch?: typeof globalThis.fetch;
  readonly createServerFn?: typeof createServer;
}

export interface CodexResponsesBridgeHandle {
  readonly baseUrl: string;
  readonly port: number;
  readonly turns: readonly CodexBridgeTurnRecord[];
  readonly lastError?: string;
  close(): void;
}

const INITIAL_DIGEST_PREFIX = "naia-pi-receipt-journal-v1";
const MONEY = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function initializeNaiaPiReceiptJournal(path: string, executionId: string): void {
  assertExecutionId(executionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeJournal(path, {
    schemaVersion: 1,
    executionId,
    headDigest: initialDigest(executionId),
    entries: [],
  });
}

export function readNaiaPiReceiptJournal(path: string, expectedExecutionId?: string): NaiaPiReceiptJournal {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!record(raw) || raw.schemaVersion !== 1 || typeof raw.executionId !== "string"
    || typeof raw.headDigest !== "string" || !Array.isArray(raw.entries)) {
    throw new Error("Naia Pi billing journal schema mismatch");
  }
  assertExecutionId(raw.executionId);
  if (expectedExecutionId !== undefined && raw.executionId !== expectedExecutionId) {
    throw new Error("Naia Pi billing journal execution mismatch");
  }
  const executionId = raw.executionId;
  let previous = initialDigest(executionId);
  const entries: JournalEntry[] = [];
  const localIds = new Set<string>();
  const gatewayIds = new Set<string>();
  raw.entries.forEach((candidate, index) => {
    if (!record(candidate) || !record(candidate.receipt)
      || candidate.previousDigest !== previous || typeof candidate.digest !== "string") {
      throw new Error(`Naia Pi billing journal chain mismatch at ${index + 1}`);
    }
    const receipt = validateReceipt(candidate.receipt, executionId, index + 1);
    const digest = entryDigest(previous, receipt);
    if (candidate.digest !== digest) throw new Error(`Naia Pi billing journal digest mismatch at ${index + 1}`);
    if (localIds.has(receipt.localRequestId) || gatewayIds.has(receipt.gatewayRequestId)) {
      throw new Error("Naia Pi billing journal duplicate identity");
    }
    localIds.add(receipt.localRequestId);
    gatewayIds.add(receipt.gatewayRequestId);
    entries.push({ receipt, previousDigest: previous, digest });
    previous = digest;
  });
  if (raw.headDigest !== previous) throw new Error("Naia Pi billing journal head mismatch");
  return { schemaVersion: 1, executionId, headDigest: previous, entries };
}

export function appendNaiaPiGatewayReceipt(path: string, receipt: NaiaPiGatewayBillingReceipt): void {
  const journal = readNaiaPiReceiptJournal(path, receipt.executionId);
  const validated = validateReceipt(receipt, journal.executionId, journal.entries.length + 1);
  if (journal.entries.some((entry) => entry.receipt.localRequestId === validated.localRequestId
    || entry.receipt.gatewayRequestId === validated.gatewayRequestId)) {
    throw new Error("Naia Pi billing receipt identity already exists");
  }
  const digest = entryDigest(journal.headDigest, validated);
  writeJournal(path, {
    ...journal,
    headDigest: digest,
    entries: [...journal.entries, { receipt: validated, previousDigest: journal.headDigest, digest }],
  });
}

export function sumGatewayCustomerCost(receipts: readonly GatewayBillingReceipt[]): number {
  let units = 0n;
  for (const receipt of receipts) {
    const [whole, fraction = ""] = receipt.customerCostDecimal.split(".");
    units += BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  }
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("gateway customer-cost aggregate exceeds safe range");
  return Number(units) / 100_000_000;
}

export function makeNaiaVersionedBillingFetch(options: VersionedBillingFetchOptions): typeof globalThis.fetch {
  assertExecutionId(options.executionId);
  const delegate = options.delegate ?? globalThis.fetch;
  let nextRequest = readNaiaPiReceiptJournal(options.journalPath, options.executionId).entries.length + 1;
  const attempts = new Map<string, { readonly index: number; readonly requestId: string; attempt: number }>();

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = parseRequestBody(input, init);
    const model = nonempty(body.model, "Naia Pi gateway request model missing");
    const canonical = stableJson({ ...body, stream: undefined, stream_options: undefined,
      gateway_request_id: undefined, gateway_attempt: undefined });
    const requestHash = sha256(canonical);
    let state = attempts.get(requestHash);
    if (!state) {
      const index = nextRequest++;
      state = { index, requestId: `naia-pi-${options.executionId}-${index}`, attempt: 0 };
      attempts.set(requestHash, state);
    }
    state.attempt += 1;
    const outbound = {
      ...body,
      stream: false,
      stream_options: undefined,
      gateway_request_id: state.requestId,
      gateway_attempt: state.attempt,
    };
    const headers = new Headers(init?.headers);
    headers.delete("content-length");
    const nextInit: RequestInit = { ...init, headers, body: JSON.stringify(outbound) };
    reserveGatewayRequest(options.gatewayBudget.path, options.gatewayBudget.policy, state.requestId, requestHash);
    const response = await delegate(input, nextInit);
    const responseText = await response.text();
    if (!response.ok) return cloneResponse(response, responseText);
    const payload = parseObject(responseText, "Naia Pi gateway response is not JSON");
    const receipt = receiptFromResponse(payload, {
      executionId: options.executionId,
      localRequestId: `${options.executionId}:call:${state.index}`,
      gatewayRequestId: state.requestId,
      gatewayAttempt: state.attempt,
      model,
    });
    const sse = completionAsSse(response, payload);
    // Append receipt to the hash-chained journal before settling the reservation so any post-call
    // reservation overrun ("gateway receipt exceeded its durable reservation") leaves both the
    // SQLite settled row and the journal entry intact for fail-closed orphan receipt reconciliation.
    appendNaiaPiGatewayReceipt(options.journalPath, receipt);
    settleGatewayRequest(options.gatewayBudget.path, options.gatewayBudget.policy, state.requestId, receipt);
    attempts.delete(requestHash);
    return sse;
  };
}

/**
 * Strip `tools`, `tool_choice`, `parallel_tool_calls`, and `additional_tools` instructions
 * from a `/v1/responses` or `/v1/chat/completions` request payload when `noTools: true` (Doc L138).
 */
export function stripToolsFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  delete next.tools;
  delete next.tool_choice;
  delete next.parallel_tool_calls;
  delete next.additional_tools;
  if (typeof next.instructions === "string") {
    next.instructions = stripAdditionalToolsText(next.instructions);
  }
  if (Array.isArray(next.input)) {
    next.input = next.input
      .map((item) => {
        if (!record(item)) return item;
        if (typeof item.content === "string") {
          const cleaned = stripAdditionalToolsText(item.content);
          return cleaned.trim() ? { ...item, content: cleaned } : null;
        }
        if (Array.isArray(item.content)) {
          const parts = item.content
            .map((part) => {
              if (!record(part) || typeof part.text !== "string") return part;
              const cleaned = stripAdditionalToolsText(part.text);
              return cleaned.trim() ? { ...part, text: cleaned } : null;
            })
            .filter(Boolean);
          return parts.length > 0 ? { ...item, content: parts } : null;
        }
        return item;
      })
      .filter(Boolean);
  }
  if (Array.isArray(next.messages)) {
    next.messages = next.messages
      .map((msg) => {
        if (!record(msg) || typeof msg.content !== "string") return msg;
        const cleaned = stripAdditionalToolsText(msg.content);
        return cleaned.trim() || msg.role === "user" ? { ...msg, content: cleaned } : null;
      })
      .filter(Boolean);
  }
  return next;
}

function stripAdditionalToolsText(text: string): string {
  return text
    .replace(/<additional_tools>[\s\S]*?<\/additional_tools>/giu, "")
    .replace(/##\s*Additional\s+Tools[\s\S]*?(?=\n##\s|$)/giu, "");
}

/**
 * Converts a Codex `/v1/responses` request body into an OpenAI `/v1/chat/completions` request body.
 */
export function convertResponsesToChatCompletionsRequest(
  rawBody: Record<string, unknown>,
  options: {
    readonly expectedModel: string;
    readonly noTools?: boolean;
    readonly maxOutputTokens?: number;
    readonly reasoningByCallId?: ReadonlyMap<string, string>;
    readonly lastReasoningContent?: string;
    readonly ollamaThink?: boolean | string;
  },
): Record<string, unknown> {
  const body = options.noTools ? stripToolsFromPayload(rawBody) : rawBody;
  const messages: Record<string, unknown>[] = [];

  if (typeof body.instructions === "string" && body.instructions.trim().length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!record(item)) continue;
      if (item.type === "function_call") {
        const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "call_1";
        const toolCall = {
          id: callId,
          type: "function",
          function: {
            name: typeof item.name === "string" ? item.name : "unknown",
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        };
        const reasoning = options.reasoningByCallId?.get(callId) ?? options.lastReasoningContent;
        const prev = messages.at(-1);
        if (prev && prev.role === "assistant") {
          const existing = Array.isArray(prev.tool_calls) ? prev.tool_calls : [];
          prev.tool_calls = [...existing, toolCall];
          if (reasoning && prev.reasoning_content === undefined) {
            prev.reasoning_content = reasoning;
          }
        } else {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [toolCall],
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          });
        }
        continue;
      }
      if (item.type === "function_call_output") {
        const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "call_1";
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: output,
        });
        continue;
      }
      if (item.type === "message" || typeof item.role === "string") {
        const rawRole = typeof item.role === "string" ? item.role : "user";
        // Naia and local providers use supportsDeveloperRole: false -> map developer to system
        const role = rawRole === "developer" ? "system" : rawRole;
        let text = "";
        if (typeof item.content === "string") {
          text = item.content;
        } else if (Array.isArray(item.content)) {
          text = item.content
            .map((part) => (record(part) && typeof part.text === "string" ? part.text : ""))
            .join("");
        }
        const reasoningContent = typeof item.reasoning_content === "string" ? item.reasoning_content : undefined;
        messages.push({
          role,
          content: text,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        });
      }
    }
  } else if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (record(msg)) messages.push({ ...msg });
    }
  }

  const chatRequest: Record<string, unknown> = {
    model: options.expectedModel,
    messages,
    stream: false,
  };

  const maxTokens = options.maxOutputTokens
    ?? (options.expectedModel === "motif-3" ? 8192 : typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined);
  if (maxTokens !== undefined) {
    chatRequest.max_tokens = maxTokens;
  }

  if (options.ollamaThink !== undefined) {
    chatRequest.think = options.ollamaThink;
  }

  if (!options.noTools && Array.isArray(body.tools)) {
    const convertedTools = body.tools
      .filter((t): t is Record<string, unknown> => record(t) && t.type === "function")
      .map((t) => {
        const fn = record(t.function) ? t.function : t;
        const name = typeof fn.name === "string" ? fn.name : "";
        if (!name) return null;
        return {
          type: "function",
          function: {
            name,
            ...(typeof fn.description === "string" ? { description: fn.description } : {}),
            parameters: record(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
          },
        };
      })
      .filter(Boolean);
    if (convertedTools.length > 0) {
      chatRequest.tools = convertedTools;
    }
  }

  return chatRequest;
}

/**
 * Starts an in-process HTTP loopback bridge on `127.0.0.1:0` that translates
 * Codex CLI `/v1/responses` requests into `/v1/chat/completions` calls, enforces
 * versioned gateway billing & receipt journals when configured, and records per-turn
 * `provider_reported` model evidence.
 */
export async function startCodexResponsesLoopbackBridge(
  options: CodexResponsesBridgeOptions,
): Promise<CodexResponsesBridgeHandle> {
  const turns: CodexBridgeTurnRecord[] = [];
  const reasoningByCallId = new Map<string, string>();
  let lastReasoningContent: string | undefined;
  let lastError: string | undefined;
  let ollamaThinkResolved = false;
  let ollamaThinkValue: boolean | string | undefined;
  const delegateFetch = options.fetch ?? globalThis.fetch;
  const billingFetch = options.billing
    ? makeNaiaVersionedBillingFetch({
        executionId: options.billing.executionId,
        journalPath: options.billing.journalPath,
        gatewayBudget: options.billing.gatewayBudget,
        delegate: delegateFetch,
      })
    : undefined;

  const createServerImpl = options.createServerFn ?? createServer;
  const server = createServerImpl((req: IncomingMessage, res: ServerResponse) => {
    void handleBridgeRequest(req, res).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: msg, type: "bridge_error" } }));
    });
  });

  async function resolveOllamaThink(): Promise<boolean | string | undefined> {
    if (ollamaThinkResolved) return ollamaThinkValue;
    ollamaThinkResolved = true;
    if (options.provider.toLowerCase() !== "ollama" || !options.thinkingLevel) return undefined;
    try {
      const showUrl = `${options.upstreamBaseUrl.replace(/\/v1\/?$/u, "")}/api/show`;
      const showRes = await delegateFetch(showUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: options.expectedModel }),
      });
      if (showRes.ok) {
        const showJson = (await showRes.json()) as Record<string, unknown>;
        const caps = Array.isArray(showJson.capabilities) ? showJson.capabilities : [];
        if (caps.includes("thinking")) {
          ollamaThinkValue = options.thinkingLevel === "off" || options.thinkingLevel === "none" ? false : true;
        }
      }
    } catch {
      /* best-effort capability probe */
    }
    return ollamaThinkValue;
  }

  async function handleBridgeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.bridgeToken) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${options.bridgeToken}`) {
        lastError = "Codex loopback bridge authorization token mismatch";
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: lastError, type: "authentication_error" } }));
        return;
      }
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawText = Buffer.concat(chunks).toString("utf8");
    const rawBody = parseObject(rawText || "{}", "Codex bridge request body is not JSON");

    const ollamaThink = await resolveOllamaThink();
    const chatRequest = convertResponsesToChatCompletionsRequest(rawBody, {
      expectedModel: options.expectedModel,
      noTools: options.noTools,
      maxOutputTokens: options.maxOutputTokens,
      reasoningByCallId,
      lastReasoningContent,
      ...(ollamaThink !== undefined ? { ollamaThink } : {}),
    });

    const upstreamUrl = `${options.upstreamBaseUrl.replace(/\/+$/u, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.provider === "naia" || options.provider === "nextain") {
      const liveKey = options.getApiKey?.()?.trim();
      if (!liveKey) {
        throw new Error("NAIA_API_KEY is required for Naia gateway bridge call");
      }
      headers["X-AnyLLM-Key"] = `Bearer ${liveKey}`;
    }

    let completionPayload: Record<string, unknown>;
    let latestReceipt: NaiaPiGatewayBillingReceipt | undefined;
    if (billingFetch && options.billing) {
      const upstreamRes = await billingFetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(chatRequest),
      });
      const sseOrJson = await upstreamRes.text();
      if (!upstreamRes.ok) {
        lastError = `Upstream gateway returned HTTP ${upstreamRes.status}`;
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
        res.end(sseOrJson);
        return;
      }
      completionPayload = extractCompletionFromBillingSse(sseOrJson);
      const journal = readNaiaPiReceiptJournal(options.billing.journalPath, options.billing.executionId);
      latestReceipt = journal.entries.at(-1)?.receipt;
    } else {
      const upstreamRes = await delegateFetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(chatRequest),
      });
      const text = await upstreamRes.text();
      if (!upstreamRes.ok) {
        lastError = `Upstream provider returned HTTP ${upstreamRes.status}`;
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
      completionPayload = parseObject(text, "Upstream chat completion response is not JSON");
    }

    const responseModel = typeof completionPayload.model === "string" && completionPayload.model.trim()
      ? completionPayload.model.trim()
      : options.expectedModel;
    if (responseModel.toLowerCase() !== options.expectedModel.toLowerCase()) {
      throw new Error(`Provider response model '${responseModel}' does not match requested model '${options.expectedModel}'`);
    }

    const usageObj = record(completionPayload.usage) ? completionPayload.usage : {};
    const promptTokens = typeof usageObj.prompt_tokens === "number" ? usageObj.prompt_tokens : 0;
    const completionTokens = typeof usageObj.completion_tokens === "number" ? usageObj.completion_tokens : 0;
    const totalTokens = typeof usageObj.total_tokens === "number" ? usageObj.total_tokens : promptTokens + completionTokens;
    const detailsObj = record(usageObj.prompt_tokens_details) ? usageObj.prompt_tokens_details : {};
    const cachedTokens = typeof detailsObj.cached_tokens === "number" ? detailsObj.cached_tokens : 0;

    turns.push({
      requestModel: options.expectedModel,
      responseModel,
      inputTokens: Math.max(0, promptTokens - cachedTokens),
      cachedInputTokens: cachedTokens,
      outputTokens: completionTokens,
      totalTokens,
      ...(latestReceipt ? { receipt: latestReceipt } : {}),
    });

    const turnIdx = turns.length;
    const choices = Array.isArray(completionPayload.choices) ? completionPayload.choices : [];
    const firstChoice = record(choices[0]) ? choices[0] : {};
    const message = record(firstChoice.message) ? firstChoice.message : record(firstChoice.delta) ? firstChoice.delta : {};

    if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
      lastReasoningContent = message.reasoning_content;
    }

    const outputItems: Record<string, unknown>[] = [];
    const contentText = typeof message.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (contentText.length > 0 || toolCalls.length === 0) {
      outputItems.push({
        type: "message",
        id: `msg_${turnIdx}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: contentText, annotations: [] }],
      });
    }

    toolCalls.forEach((rawTc, idx) => {
      if (!record(rawTc)) return;
      const fn = record(rawTc.function) ? rawTc.function : {};
      const callId = typeof rawTc.id === "string" && rawTc.id ? rawTc.id : `call_${turnIdx}_${idx}`;
      const rawName = typeof fn.name === "string" ? fn.name : "exec_command";
      const rawArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      if (lastReasoningContent) {
        reasoningByCallId.set(callId, lastReasoningContent);
      }
      outputItems.push({
        type: "function_call",
        id: `fc_${turnIdx}_${idx}`,
        call_id: callId,
        name: rawName,
        arguments: rawArgs,
        status: "completed",
      });
    });

    const responseObj = {
      id: typeof completionPayload.id === "string" ? completionPayload.id : `resp_${turnIdx}`,
      object: "response",
      created_at: typeof completionPayload.created === "number" ? completionPayload.created : Math.floor(Date.now() / 1000),
      status: "completed",
      model: responseModel,
      output: outputItems,
      usage: {
        input_tokens: promptTokens,
        input_tokens_details: { cached_tokens: cachedTokens },
        output_tokens: completionTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: totalTokens,
      },
    };

    const wantsJsonOnly = rawBody.stream === false && !String(req.headers.accept ?? "").includes("text/event-stream");
    if (wantsJsonOnly) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(responseObj));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      `event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { ...responseObj, status: "in_progress", output: [] },
      })}\n\n`,
    );
    outputItems.forEach((item, outputIndex) => {
      if (item.type === "message") {
        const itemId = String(item.id);
        res.write(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
          })}\n\n`,
        );
        if (contentText.length > 0) {
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              delta: contentText,
            })}\n\n`,
          );
        }
        res.write(
          `event: response.output_text.done\ndata: ${JSON.stringify({
            type: "response.output_text.done",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            text: contentText,
          })}\n\n`,
        );
        res.write(
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          })}\n\n`,
        );
      } else if (item.type === "function_call") {
        const itemId = String(item.id);
        const argsStr = String(item.arguments ?? "{}");
        res.write(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { ...item, status: "in_progress", arguments: "" },
          })}\n\n`,
        );
        res.write(
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: itemId,
            output_index: outputIndex,
            delta: argsStr,
          })}\n\n`,
        );
        res.write(
          `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: itemId,
            output_index: outputIndex,
            arguments: argsStr,
          })}\n\n`,
        );
        res.write(
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          })}\n\n`,
        );
      }
    });
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: responseObj,
      })}\n\n`,
    );
    res.end();
  }

  // Bind via public Node HTTP server.listen(0, "127.0.0.1") and await the "listening" event
  // without relying on private server._listen2 internals. Fail closed if no valid port is assigned.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  server.unref();

  const addr = server.address();
  const port = addr && typeof addr === "object" && typeof addr.port === "number" ? addr.port : 0;
  if (!Number.isInteger(port) || port <= 0) {
    try {
      server.close();
    } catch {
      /* ignore close error */
    }
    throw new Error("Codex loopback bridge failed to bind a valid loopback port");
  }
  let closed = false;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    get turns() {
      return turns;
    },
    get lastError() {
      return lastError;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function extractCompletionFromBillingSse(sseText: string): Record<string, unknown> {
  const dataLine = sseText
    .split(/\r?\n/u)
    .find((line) => line.startsWith("data: ") && line.trim() !== "data: [DONE]");
  if (!dataLine) {
    return parseObject(sseText, "Naia billing SSE response missing data chunk");
  }
  const chunk = parseObject(dataLine.slice(6), "Naia billing SSE chunk is not JSON");
  if (Array.isArray(chunk.choices)) {
    const choices = chunk.choices.map((c) => {
      if (!record(c)) return c;
      if (record(c.delta) && !record(c.message)) {
        return { ...c, message: c.delta };
      }
      return c;
    });
    return { ...chunk, choices };
  }
  return chunk;
}

export function initializeGatewayRequestBudget(path: string, policy: GatewayRequestBudgetPolicy): void {
  const db = openGatewayBudget(path, policy); db.close();
}

export function readGatewayRequestBudget(path: string, policy: GatewayRequestBudgetPolicy): GatewayRequestBudgetSnapshot {
  const db = openGatewayBudget(path, policy);
  try { return gatewayBudgetSnapshot(db); } finally { db.close(); }
}

/** Returns the complete durable request ledger, sorted for deterministic benchmark attestation. */
export function readGatewayRequestBudgetEvidence(path: string,
  policy: GatewayRequestBudgetPolicy): GatewayRequestBudgetEvidence {
  const db = openGatewayBudget(path, policy);
  try {
    const rows = db.prepare(`SELECT request_id,status,actual_cost_units,actual_input_tokens,
      actual_output_tokens,receipt_digest FROM gateway_request_reservations ORDER BY request_id`).all() as Record<string, unknown>[];
    const evidenceRows = rows.map((row): GatewayRequestBudgetEvidenceRow => {
      if (typeof row.request_id !== "string" || (row.status !== "active" && row.status !== "settled")) {
        throw new Error("gateway request ledger row malformed");
      }
      if (row.status === "active") return { requestId: row.request_id, status: "active" };
      if (!Number.isSafeInteger(row.actual_cost_units) || Number(row.actual_cost_units) < 0
        || !Number.isSafeInteger(row.actual_input_tokens) || Number(row.actual_input_tokens) < 0
        || !Number.isSafeInteger(row.actual_output_tokens) || Number(row.actual_output_tokens) < 0
        || typeof row.receipt_digest !== "string" || !row.receipt_digest) {
        throw new Error("settled gateway request ledger row malformed");
      }
      return { requestId: row.request_id, status: "settled",
        actualCostDecimal: moneyDecimal(Number(row.actual_cost_units)),
        actualInputTokens: Number(row.actual_input_tokens), actualOutputTokens: Number(row.actual_output_tokens),
        receiptDigest: row.receipt_digest };
    });
    const snapshot = gatewayBudgetSnapshot(db);
    const chargedUnits = evidenceRows.reduce((sum, row) => row.status === "settled"
      ? sum + moneyUnits(row.actualCostDecimal!) : sum, 0);
    return { rows: evidenceRows, snapshot: { ...snapshot, chargedUsdDecimal: moneyDecimal(chargedUnits) } };
  } finally { db.close(); }
}

/** Digest used by the durable gateway ledger to bind a settled journal receipt. */
export function naiaPiGatewayReceiptDigest(receipt: NaiaPiGatewayBillingReceipt): string {
  return sha256(stableJson({ ...receipt, gatewayAttempt: undefined, responseId: undefined }));
}

function reserveGatewayRequest(path: string, policy: GatewayRequestBudgetPolicy, requestId: string, requestDigest: string): void {
  const db = openGatewayBudget(path, policy);
  try {
    immediate(db, () => {
      const prior = db.prepare("SELECT request_digest,status FROM gateway_request_reservations WHERE request_id=?")
        .get(requestId) as Record<string, unknown> | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new Error("gateway request budget identity conflict");
        if (prior.status !== "active") throw new Error("gateway request identity is already settled");
        return;
      }
      const snapshot = gatewayBudgetSnapshot(db); const allowance = policy.requestAllowance;
      if (snapshot.gatewayCalls + 1 > policy.maxGatewayCalls
        || snapshot.chargedUsd + allowance.reservedUsd > policy.maxUsd
        || snapshot.chargedInputTokens + allowance.reservedInputTokens > policy.maxInputTokens
        || snapshot.chargedOutputTokens + allowance.reservedOutputTokens > policy.maxOutputTokens) {
        throw new Error("gateway request exceeds durable pre-call budget");
      }
      db.prepare(`INSERT INTO gateway_request_reservations
        (request_id,request_digest,status,reserved_cost_units,reserved_input_tokens,reserved_output_tokens)
        VALUES(?,?,'active',?,?,?)`).run(requestId, requestDigest, moneyUnits(numberMoney(allowance.reservedUsd)),
          allowance.reservedInputTokens, allowance.reservedOutputTokens);
    });
  } finally { db.close(); }
}

function settleGatewayRequest(path: string, policy: GatewayRequestBudgetPolicy, requestId: string,
  receipt: NaiaPiGatewayBillingReceipt): void {
  const db = openGatewayBudget(path, policy);
  const receiptDigest = naiaPiGatewayReceiptDigest(receipt);
  try {
    const exceeded = immediate(db, () => {
      const prior = db.prepare("SELECT * FROM gateway_request_reservations WHERE request_id=?")
        .get(requestId) as Record<string, unknown> | undefined;
      if (!prior) throw new Error("gateway receipt has no pre-call reservation");
      if (prior.status === "settled") {
        if (prior.receipt_digest !== receiptDigest) throw new Error("gateway request settlement conflict");
        return false;
      }
      const actualInput = receipt.inputTokens + receipt.cachedInputTokens;
      const actualUnits = moneyUnits(receipt.customerCostDecimal);
      db.prepare(`UPDATE gateway_request_reservations SET status='settled',actual_cost_units=?,
        actual_input_tokens=?,actual_output_tokens=?,receipt_digest=? WHERE request_id=? AND status='active'`)
        .run(actualUnits, actualInput, receipt.outputTokens, receiptDigest, requestId);
      const snapshot = gatewayBudgetSnapshot(db);
      return actualUnits > Number(prior.reserved_cost_units) || actualInput > Number(prior.reserved_input_tokens)
        || receipt.outputTokens > Number(prior.reserved_output_tokens) || snapshot.chargedUsd > policy.maxUsd
        || snapshot.chargedInputTokens > policy.maxInputTokens || snapshot.chargedOutputTokens > policy.maxOutputTokens;
    });
    if (exceeded) throw new Error("gateway receipt exceeded its durable reservation");
  } finally { db.close(); }
}

function openGatewayBudget(path: string, policy: GatewayRequestBudgetPolicy): Database.Database {
  assertGatewayBudgetPolicy(policy); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path); db.pragma("busy_timeout = 5000"); db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_request_budget_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),policy_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_request_reservations(
      request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','settled')),
      reserved_cost_units INTEGER NOT NULL,reserved_input_tokens INTEGER NOT NULL,reserved_output_tokens INTEGER NOT NULL,
      actual_cost_units INTEGER,actual_input_tokens INTEGER,actual_output_tokens INTEGER,receipt_digest TEXT);`);
  const canonical = stableJson(policy);
  const prior = db.prepare("SELECT policy_json FROM gateway_request_budget_policy WHERE singleton=1").get() as Record<string, unknown> | undefined;
  if (prior && prior.policy_json !== canonical) { db.close(); throw new Error("persisted gateway request budget policy mismatch"); }
  if (!prior) db.prepare("INSERT INTO gateway_request_budget_policy(singleton,policy_json) VALUES(1,?)").run(canonical);
  privateSqliteFiles(path); return db;
}

function gatewayBudgetSnapshot(db: Database.Database): GatewayRequestBudgetSnapshot {
  const row = db.prepare(`SELECT COUNT(*) gateway_calls,
    COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) active_reservations,
    COALESCE(SUM(CASE WHEN status='active' THEN reserved_cost_units ELSE actual_cost_units END),0) cost_units,
    COALESCE(SUM(CASE WHEN status='active' THEN reserved_input_tokens ELSE actual_input_tokens END),0) input_tokens,
    COALESCE(SUM(CASE WHEN status='active' THEN reserved_output_tokens ELSE actual_output_tokens END),0) output_tokens
    FROM gateway_request_reservations`).get() as Record<string, unknown>;
  return { gatewayCalls: Number(row.gateway_calls), activeReservations: Number(row.active_reservations),
    chargedUsd: Number(row.cost_units) / 100_000_000, chargedInputTokens: Number(row.input_tokens),
    chargedOutputTokens: Number(row.output_tokens) };
}

function immediate<T>(db: Database.Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function assertGatewayBudgetPolicy(policy: GatewayRequestBudgetPolicy): void {
  const allowance = policy.requestAllowance;
  if (!Number.isSafeInteger(policy.maxGatewayCalls) || policy.maxGatewayCalls <= 0
    || !positiveMoney(policy.maxUsd) || !positiveInt(policy.maxInputTokens) || !positiveInt(policy.maxOutputTokens)
    || !positiveMoney(allowance.reservedUsd) || !positiveInt(allowance.reservedInputTokens)
    || !positiveInt(allowance.reservedOutputTokens)) throw new Error("gateway request budget policy invalid");
}

function numberMoney(value: number): string { return value.toFixed(8); }
function moneyUnits(value: string): number {
  if (!MONEY.test(value)) throw new Error("gateway budget amount invalid");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("gateway budget amount exceeds safe range");
  return Number(units);
}
function moneyDecimal(units: number): string {
  if (!Number.isSafeInteger(units) || units < 0) throw new Error("gateway budget amount invalid");
  const whole = Math.floor(units / 100_000_000); const fraction = String(units % 100_000_000).padStart(8, "0");
  return `${whole}.${fraction}`;
}
function positiveMoney(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 90_000_000; }
function positiveInt(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function privateSqliteFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) try { chmodSync(file, 0o600); } catch { /* Windows ACL or absent sidecar. */ }
}

function parseRequestBody(input: string | URL | Request, init?: RequestInit): Record<string, unknown> {
  const raw = init?.body ?? (input instanceof Request ? input.body : undefined);
  if (typeof raw !== "string") throw new Error("Naia Pi billing bridge requires a JSON request body");
  return parseObject(raw, "Naia Pi gateway request is not JSON");
}

function receiptFromResponse(payload: Record<string, unknown>, expected: {
  readonly executionId: string; readonly localRequestId: string; readonly gatewayRequestId: string;
  readonly gatewayAttempt: number; readonly model: string;
}): NaiaPiGatewayBillingReceipt {
  if (payload.gateway_request_id !== expected.gatewayRequestId || payload.gateway_attempt !== expected.gatewayAttempt) {
    throw new Error("Naia Pi gateway billing identity mismatch");
  }
  if (payload.settlement_status !== "settled" || payload.billing_status !== "settled") {
    throw new Error("Naia Pi gateway billing is not settled");
  }
  const customerCostDecimal = nonempty(payload.customer_cost, "Naia Pi customer cost missing");
  if (!MONEY.test(customerCostDecimal)) throw new Error("Naia Pi customer cost is not an exact nonnegative amount");
  const customerCostUsd = Number(customerCostDecimal);
  if (!Number.isFinite(customerCostUsd)) throw new Error("Naia Pi customer cost is outside numeric range");
  const priceVersionId = nonempty(payload.price_version_id, "Naia Pi price version missing");
  const currency = nonempty(payload.currency, "Naia Pi billing currency missing");
  if (currency.toUpperCase() !== "USD") throw new Error("Naia Pi billing currency is not USD");
  const responseModel = nonempty(payload.model, "Naia Pi gateway response model missing");
  if (responseModel !== expected.model) throw new Error("Naia Pi gateway response model does not match the billed route");
  const usage = record(payload.usage) ? payload.usage : undefined;
  if (!usage) throw new Error("Naia Pi gateway usage missing");
  const inputTokens = token(usage.prompt_tokens, "prompt_tokens");
  const outputTokens = token(usage.completion_tokens, "completion_tokens");
  const totalTokens = token(usage.total_tokens, "total_tokens");
  const details = record(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cachedInputTokens = details?.cached_tokens === undefined ? 0 : token(details.cached_tokens, "cached_tokens");
  if (cachedInputTokens > inputTokens || totalTokens < inputTokens + outputTokens) {
    throw new Error("Naia Pi gateway usage totals are inconsistent");
  }
  return {
    source: "gateway_versioned_customer_billing",
    executionId: expected.executionId,
    localRequestId: expected.localRequestId,
    gatewayRequestId: expected.gatewayRequestId,
    gatewayAttempt: expected.gatewayAttempt,
    provider: "naia",
    model: expected.model,
    responseModel,
    ...(typeof payload.id === "string" && payload.id.trim() ? { responseId: payload.id } : {}),
    inputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    customerCostDecimal,
    customerCostUsd,
    priceVersionId,
    currency: currency.toUpperCase(),
    settlementStatus: "settled",
  };
}

function completionAsSse(response: Response, payload: Record<string, unknown>): Response {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new Error("Naia Pi gateway completion choices missing");
  }
  const choices = payload.choices.map((raw, index) => {
    if (!record(raw) || !record(raw.message)) throw new Error(`Naia Pi completion choice ${index} malformed`);
    return {
      index: typeof raw.index === "number" ? raw.index : index,
      delta: raw.message,
      finish_reason: raw.finish_reason ?? null,
      ...(raw.logprobs !== undefined ? { logprobs: raw.logprobs } : {}),
    };
  });
  const chunk = {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl-naia-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
    model: typeof payload.model === "string" ? payload.model : "unknown",
    choices,
    ...(record(payload.usage) ? { usage: payload.usage } : {}),
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cloneResponse(response: Response, body: string): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function validateReceipt(raw: Record<string, unknown> | NaiaPiGatewayBillingReceipt,
  executionId: string, expectedIndex: number): NaiaPiGatewayBillingReceipt {
  const receipt = raw as unknown as NaiaPiGatewayBillingReceipt;
  if (receipt.source !== "gateway_versioned_customer_billing" || receipt.executionId !== executionId
    || receipt.provider !== "naia" || receipt.settlementStatus !== "settled") {
    throw new Error("Naia Pi billing receipt binding mismatch");
  }
  const expectedLocal = `${executionId}:call:${expectedIndex}`;
  const expectedGateway = `naia-pi-${executionId}-${expectedIndex}`;
  if (receipt.localRequestId !== expectedLocal || receipt.gatewayRequestId !== expectedGateway
    || !Number.isSafeInteger(receipt.gatewayAttempt) || receipt.gatewayAttempt < 1) {
    throw new Error("Naia Pi billing receipt order mismatch");
  }
  for (const [name, value] of [["input", receipt.inputTokens], ["cached", receipt.cachedInputTokens],
    ["output", receipt.outputTokens], ["total", receipt.totalTokens]] as const) token(value, name);
  if (receipt.totalTokens < receipt.inputTokens + receipt.cachedInputTokens + receipt.outputTokens) {
    throw new Error("Naia Pi billing receipt token totals are inconsistent");
  }
  if (!nonempty(receipt.model, "Naia Pi billing receipt model missing")
    || !nonempty(receipt.priceVersionId, "Naia Pi billing receipt price version missing")
    || receipt.currency !== "USD" || !MONEY.test(receipt.customerCostDecimal)
    || Number(receipt.customerCostDecimal) !== receipt.customerCostUsd
    || !Number.isFinite(receipt.customerCostUsd) || receipt.customerCostUsd < 0) {
    throw new Error("Naia Pi billing receipt amount or route invalid");
  }
  return receipt;
}

function writeJournal(path: string, journal: NaiaPiReceiptJournal): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${stableJson(journal)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are enforced by the parent directory. */ }
}

function initialDigest(executionId: string): string { return sha256(`${INITIAL_DIGEST_PREFIX}:${executionId}`); }
function entryDigest(previous: string, receipt: NaiaPiGatewayBillingReceipt): string {
  return sha256(`${previous}\n${stableJson(receipt)}`);
}
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function parseObject(raw: string, message: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(message); }
  if (!record(value)) throw new Error(message);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(message);
  return value;
}
function token(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Naia Pi billing ${name} token count invalid`);
  }
  return value;
}
function assertExecutionId(value: string): void {
  if (!UUID.test(value)) throw new Error("Naia Pi execution identity must be a UUID");
}
