// UC-ORCH-004 / FR-LOOP-008 — request-correlated atomic gateway billing for the Naia Pi route.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    appendNaiaPiGatewayReceipt(options.journalPath, receipt);
    settleGatewayRequest(options.gatewayBudget.path, options.gatewayBudget.policy, state.requestId, receipt);
    attempts.delete(requestHash);
    return sse;
  };
}

export function initializeGatewayRequestBudget(path: string, policy: GatewayRequestBudgetPolicy): void {
  const db = openGatewayBudget(path, policy); db.close();
}

export function readGatewayRequestBudget(path: string, policy: GatewayRequestBudgetPolicy): GatewayRequestBudgetSnapshot {
  const db = openGatewayBudget(path, policy);
  try { return gatewayBudgetSnapshot(db); } finally { db.close(); }
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
  const receiptDigest = sha256(stableJson({ ...receipt, gatewayAttempt: undefined, responseId: undefined }));
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
