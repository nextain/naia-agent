import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import type { ActorReceipt } from "../domain/issue-orchestration.js";
import type {
  PaidCallBudgetPolicy, PaidCallBudgetPort, PaidCallBudgetSnapshot, PaidCallReservation, PaidCallReservationStatus,
} from "../ports/paid-call-budget.js";

type Row = Record<string, unknown>;

export class PaidCallBudgetExceededError extends Error {}
export class PaidCallAlreadyReservedError extends Error {}
export class PaidCallReceiptConflictError extends Error {}
export class PaidCallReceiptUnavailableError extends Error {}
export class PaidCallBudgetSchemaError extends Error {}

const SCHEMA_VERSION = 1;

export class SqlitePaidCallBudget implements PaidCallBudgetPort {
  readonly #db: Database.Database;

  constructor(readonly path: string, readonly policy: PaidCallBudgetPolicy) {
    assertPolicy(policy);
    this.#db = new Database(path);
    this.#db.pragma("busy_timeout = 5000");
    this.#db.pragma("journal_mode = WAL");
    const version = Number(this.#db.pragma("user_version", { simple: true }));
    if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
      this.#db.close(); throw new PaidCallBudgetSchemaError(`unsupported paid-call budget schema version: ${version}`);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS paid_call_budget_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paid_call_reservations (
        idempotency_key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('active','settled')),
        reserved_usd REAL NOT NULL,
        reserved_input_tokens INTEGER NOT NULL,
        reserved_output_tokens INTEGER NOT NULL,
        expected_provider TEXT NOT NULL,
        expected_model TEXT NOT NULL,
        expected_reasoning_effort TEXT,
        actual_usd REAL,
        actual_input_tokens INTEGER,
        actual_output_tokens INTEGER,
        cost_basis TEXT,
        receipt_digest TEXT
      );
    `);
    const columns = new Set((this.#db.pragma("table_info(paid_call_reservations)") as Row[])
      .map((row) => String(row.name)));
    const required = ["idempotency_key", "status", "reserved_usd", "reserved_input_tokens",
      "reserved_output_tokens", "expected_provider", "expected_model", "expected_reasoning_effort",
      "actual_usd", "actual_input_tokens", "actual_output_tokens", "cost_basis", "receipt_digest"];
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      this.#db.close(); throw new PaidCallBudgetSchemaError(`incompatible paid-call budget schema: missing ${missing.join(",")}`);
    }
    if (version === 0) this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
    const canonical = stableJson(policy);
    const prior = this.#db.prepare("SELECT policy_json FROM paid_call_budget_policy WHERE singleton=1").get() as Row | undefined;
    if (prior && String(prior.policy_json) !== canonical) {
      this.#db.close();
      throw new PaidCallBudgetExceededError("persisted paid-call budget policy mismatch");
    }
    if (!prior) this.#db.prepare("INSERT INTO paid_call_budget_policy(singleton,policy_json) VALUES(1,?)").run(canonical);
    this.privateFiles();
  }

  reserve(input: PaidCallReservation): void {
    assertReservation(input);
    this.transaction(() => {
      const prior = this.#db.prepare("SELECT status FROM paid_call_reservations WHERE idempotency_key=?")
        .get(input.idempotencyKey) as Row | undefined;
      if (prior) throw new PaidCallAlreadyReservedError(`paid call key is already ${String(prior.status)}`);
      const current = this.snapshotInTransaction();
      if (current.paidCalls + 1 > this.policy.maxPaidCalls
        || current.chargedUsd + input.reservedUsd > this.policy.maxUsd
        || current.chargedInputTokens + input.reservedInputTokens > this.policy.maxInputTokens
        || current.chargedOutputTokens + input.reservedOutputTokens > this.policy.maxOutputTokens) {
        throw new PaidCallBudgetExceededError("paid-call reservation exceeds durable budget");
      }
      this.#db.prepare(`INSERT INTO paid_call_reservations
        (idempotency_key,status,reserved_usd,reserved_input_tokens,reserved_output_tokens,
        expected_provider,expected_model,expected_reasoning_effort)
        VALUES(?,'active',?,?,?,?,?,?)`).run(input.idempotencyKey, input.reservedUsd,
          input.reservedInputTokens, input.reservedOutputTokens, input.expectedProvider,
          input.expectedModel, input.expectedReasoningEffort ?? null);
    });
  }

  settle(idempotencyKey: string, receipt: ActorReceipt): void {
    if (receipt.idempotencyKey !== idempotencyKey) throw new PaidCallReceiptConflictError("receipt key mismatch");
    if (![receipt.provider, receipt.model, receipt.sessionId, receipt.executionId]
      .every((value) => typeof value === "string" && value.length > 0 && value === value.trim())
      || receipt.modelEvidenceSource !== "provider_reported") {
      throw new PaidCallReceiptUnavailableError("provider-reported receipt identity evidence is required");
    }
    const actualUsd = receipt.cost.state === "measured" ? receipt.cost.usd : receipt.estimatedCostUsd;
    const actualInputTokens = receipt.inputTokens + receipt.cachedInputTokens;
    if (!receipt.tokenCountsAvailable
      || !nonNegativeInt(receipt.inputTokens) || !nonNegativeInt(receipt.cachedInputTokens)
      || !nonNegativeInt(receipt.outputTokens)
      || actualUsd === undefined || !Number.isFinite(actualUsd) || actualUsd < 0) {
      throw new PaidCallReceiptUnavailableError("complete usage and measured-or-priced cost evidence is required");
    }
    if (!Number.isSafeInteger(actualInputTokens)) {
      throw new PaidCallReceiptUnavailableError("combined input usage exceeds the safe integer range");
    }
    if (receipt.cost.state !== "measured" && receipt.estimatedCostSource !== "pi_catalog") {
      throw new PaidCallReceiptUnavailableError("estimated cost requires Pi catalog provenance");
    }
    const receiptDigest = digest(stableJson(receipt));
    let exceeded = false;
    this.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM paid_call_reservations WHERE idempotency_key=?")
        .get(idempotencyKey) as Row | undefined;
      if (!row) throw new PaidCallReceiptConflictError("receipt has no prior reservation");
      if (receipt.provider !== String(row.expected_provider) || receipt.model !== String(row.expected_model)
        || (row.expected_reasoning_effort === null ? receipt.reasoningEffort !== undefined
          : receipt.reasoningEffort !== String(row.expected_reasoning_effort))) {
        throw new PaidCallReceiptConflictError("receipt binding mismatch");
      }
      if (String(row.status) === "settled") {
        if (String(row.receipt_digest) !== receiptDigest) throw new PaidCallReceiptConflictError("conflicting receipt settlement");
        return;
      }
      this.#db.prepare(`UPDATE paid_call_reservations SET status='settled', actual_usd=?,
        actual_input_tokens=?, actual_output_tokens=?, cost_basis=?, receipt_digest=? WHERE idempotency_key=? AND status='active'`)
        .run(actualUsd, actualInputTokens, receipt.outputTokens,
          receipt.cost.state === "measured" ? "measured" : "estimated", receiptDigest, idempotencyKey);
      const snapshot = this.snapshotInTransaction();
      exceeded = actualUsd > Number(row.reserved_usd)
        || actualInputTokens > Number(row.reserved_input_tokens)
        || receipt.outputTokens > Number(row.reserved_output_tokens)
        || snapshot.chargedUsd > this.policy.maxUsd
        || snapshot.chargedInputTokens > this.policy.maxInputTokens
        || snapshot.chargedOutputTokens > this.policy.maxOutputTokens;
    });
    if (exceeded) throw new PaidCallBudgetExceededError("paid receipt exceeded its reservation or durable budget");
  }

  snapshot(): PaidCallBudgetSnapshot { return this.snapshotInTransaction(); }
  reservations(): readonly PaidCallReservationStatus[] {
    return (this.#db.prepare(`SELECT idempotency_key,status,expected_provider,expected_model,
      reserved_usd,reserved_input_tokens,reserved_output_tokens FROM paid_call_reservations ORDER BY idempotency_key`).all() as Row[])
      .map((row) => ({ idempotencyKey: String(row.idempotency_key), status: String(row.status) as "active" | "settled",
        expectedProvider: String(row.expected_provider), expectedModel: String(row.expected_model),
        reservedUsd: Number(row.reserved_usd), reservedInputTokens: Number(row.reserved_input_tokens),
        reservedOutputTokens: Number(row.reserved_output_tokens) }));
  }
  close(): void { this.#db.close(); }

  private snapshotInTransaction(): PaidCallBudgetSnapshot {
    const row = this.#db.prepare(`SELECT COUNT(*) AS paid_calls,
      COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active_reservations,
      COALESCE(SUM(CASE WHEN status='active' THEN reserved_usd ELSE actual_usd END),0) AS charged_usd,
      COALESCE(SUM(CASE WHEN status='active' THEN reserved_input_tokens ELSE actual_input_tokens END),0) AS charged_input,
      COALESCE(SUM(CASE WHEN status='active' THEN reserved_output_tokens ELSE actual_output_tokens END),0) AS charged_output
      FROM paid_call_reservations`).get() as Row;
    const bases = this.#db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN status='settled' AND cost_basis='measured' THEN 1 ELSE 0 END),0) AS measured,
      COALESCE(SUM(CASE WHEN status='settled' AND cost_basis='estimated' THEN 1 ELSE 0 END),0) AS estimated
      FROM paid_call_reservations`).get() as Row;
    const present = (["reserved", "measured", "estimated"] as const)
      .filter((basis) => Number(bases[basis]) > 0);
    const costBasis = present.length === 0 ? "none" : present.length === 1 ? present[0] : "mixed";
    return { ...this.policy, paidCalls: Number(row.paid_calls), activeReservations: Number(row.active_reservations),
      chargedUsd: Number(row.charged_usd), chargedInputTokens: Number(row.charged_input),
      chargedOutputTokens: Number(row.charged_output), costBasis };
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#db.exec("COMMIT"); this.privateFiles(); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  private privateFiles(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try { chmodSync(file, 0o600); } catch { /* Windows or sidecar not created yet. */ }
    }
  }
}

function assertPolicy(value: PaidCallBudgetPolicy): void {
  if (!Number.isSafeInteger(value.maxPaidCalls) || value.maxPaidCalls <= 0 || !finiteNonNegative(value.maxUsd)
    || !nonNegativeInt(value.maxInputTokens) || !nonNegativeInt(value.maxOutputTokens)) {
    throw new Error("invalid paid-call budget policy");
  }
}
function assertReservation(value: PaidCallReservation): void {
  if (!value.idempotencyKey.trim() || value.idempotencyKey.length > 256 || !value.expectedProvider.trim()
    || !value.expectedModel.trim() || !Number.isFinite(value.reservedUsd) || value.reservedUsd <= 0
    || !Number.isSafeInteger(value.reservedInputTokens) || value.reservedInputTokens <= 0
    || !Number.isSafeInteger(value.reservedOutputTokens) || value.reservedOutputTokens <= 0) {
    throw new Error("invalid paid-call reservation");
  }
}
function finiteNonNegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function nonNegativeInt(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
