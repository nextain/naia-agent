import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaidCallAlreadyReservedError, PaidCallBudgetExceededError, PaidCallReceiptConflictError,
  PaidCallReceiptUnavailableError, SqlitePaidCallBudget,
} from "../main/adapters/sqlite-paid-call-budget.js";
import type { ActorReceipt } from "../main/domain/issue-orchestration.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function create() {
  const root = mkdtempSync(join(tmpdir(), "naia-paid-budget-")); roots.push(root);
  const path = join(root, "budget.db");
  const policy = { maxPaidCalls: 3, maxUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 };
  return { path, policy, budget: new SqlitePaidCallBudget(path, policy) };
}
function reservation(key: string) {
  return { idempotencyKey: key, expectedProvider: "naia", expectedModel: "fixture",
    reservedUsd: 0.4, reservedInputTokens: 400, reservedOutputTokens: 200 };
}
function receipt(key: string, usd = 0.2, inputTokens = 200, outputTokens = 100): ActorReceipt {
  return { role: "worker", provider: "naia", model: "fixture", sessionId: `s-${key}`,
    executionId: `e-${key}`, idempotencyKey: key, tokenCountsAvailable: true, inputTokens,
    cachedInputTokens: 0, outputTokens, latencyMs: 1, modelEvidenceSource: "provider_reported",
    cost: { state: "measured", usd, source: "fixture" } };
}

describe("SQLite paid-call budget", () => {
  it("persists settled and unresolved charges across restart", () => {
    const { path, policy, budget } = create();
    budget.reserve(reservation("a")); budget.settle("a", receipt("a"));
    budget.reserve(reservation("b")); budget.close();
    const reopened = new SqlitePaidCallBudget(path, policy);
    expect(reopened.snapshot()).toMatchObject({ paidCalls: 2, activeReservations: 1,
      chargedInputTokens: 600, chargedOutputTokens: 300, costBasis: "mixed" });
    expect(reopened.snapshot().chargedUsd).toBeCloseTo(0.6);
    expect(() => reopened.reserve(reservation("b"))).toThrow(PaidCallAlreadyReservedError);
    reopened.close();
  });

  it("enforces calls, USD, input, and output before another provider effect", () => {
    const { budget } = create();
    budget.reserve(reservation("a")); budget.reserve(reservation("b"));
    expect(() => budget.reserve(reservation("c"))).toThrow(PaidCallBudgetExceededError);
    expect(budget.snapshot()).toMatchObject({ paidCalls: 2, activeReservations: 2 });
    budget.close();
  });

  it("makes identical settlement idempotent and rejects conflicting evidence", () => {
    const { budget } = create();
    budget.reserve(reservation("a")); const exact = receipt("a");
    budget.settle("a", exact); budget.settle("a", exact);
    expect(budget.snapshot()).toMatchObject({ paidCalls: 1, chargedUsd: 0.2 });
    expect(() => budget.settle("a", receipt("a", 0.21))).toThrow(PaidCallReceiptConflictError);
    budget.close();
  });

  it("keeps actual overrun charged while failing the call", () => {
    const { budget } = create(); budget.reserve(reservation("a"));
    expect(() => budget.settle("a", receipt("a", 0.5))).toThrow(PaidCallBudgetExceededError);
    expect(budget.snapshot()).toMatchObject({ activeReservations: 0, chargedUsd: 0.5 });
    budget.close();
  });

  it("requires complete usage and measured cost", () => {
    const { budget } = create(); budget.reserve(reservation("a"));
    const missing = { ...receipt("a"), tokenCountsAvailable: false,
      cost: { state: "unavailable" as const, reason: "missing" } };
    expect(() => budget.settle("a", missing)).toThrow(PaidCallReceiptUnavailableError);
    expect(budget.snapshot()).toMatchObject({ activeReservations: 1, chargedUsd: 0.4 });
    budget.close();
  });

  it("binds an existing database to one immutable policy", () => {
    const { path, policy, budget } = create(); budget.close();
    expect(() => new SqlitePaidCallBudget(path, { ...policy, maxUsd: 2 })).toThrow(PaidCallBudgetExceededError);
  });

  it("serializes the last allowance across two SQLite connections", () => {
    const root = mkdtempSync(join(tmpdir(), "naia-paid-budget-")); roots.push(root);
    const path = join(root, "budget.db"); const policy = { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 };
    const first = new SqlitePaidCallBudget(path, policy); const second = new SqlitePaidCallBudget(path, policy);
    first.reserve(reservation("a"));
    expect(() => second.reserve(reservation("b"))).toThrow(PaidCallBudgetExceededError);
    expect(second.snapshot()).toMatchObject({ paidCalls: 1, activeReservations: 1 });
    first.close(); second.close();
  });

  it("keeps a drifted binding unresolved instead of releasing its reservation", () => {
    const { budget } = create(); budget.reserve(reservation("a"));
    expect(() => budget.settle("a", { ...receipt("a"), model: "wrong" })).toThrow(PaidCallReceiptConflictError);
    expect(budget.reservations()).toEqual([expect.objectContaining({ idempotencyKey: "a", status: "active" })]);
    expect(budget.snapshot()).toMatchObject({ activeReservations: 1, chargedUsd: 0.4 });
    budget.close();
  });

  it("rejects zero-sized reservations", () => {
    const { budget } = create();
    expect(() => budget.reserve({ ...reservation("a"), reservedUsd: 0 })).toThrow(/invalid paid-call reservation/u);
    budget.close();
  });

  it("reports empty, reserved, measured, and estimated cost evidence without conflating them", () => {
    const { budget } = create();
    expect(budget.snapshot().costBasis).toBe("none");
    budget.reserve(reservation("a"));
    expect(budget.snapshot().costBasis).toBe("reserved");
    budget.settle("a", receipt("a"));
    expect(budget.snapshot().costBasis).toBe("measured");
    budget.reserve(reservation("b"));
    budget.settle("b", { ...receipt("b"), estimatedCostUsd: 0.2, estimatedCostSource: "pi_catalog",
      cost: { state: "unavailable", reason: "catalog estimate" } });
    expect(budget.snapshot().costBasis).toBe("mixed");
    budget.close();
  });

  it("rejects a fabricated estimate without provider identity and Pi catalog provenance", () => {
    const { budget } = create(); budget.reserve(reservation("a"));
    expect(() => budget.settle("a", { ...receipt("a"), modelEvidenceSource: "adapter_requested",
      estimatedCostUsd: 0.1, cost: { state: "unavailable", reason: "claimed estimate" } }))
      .toThrow(PaidCallReceiptUnavailableError);
    expect(budget.snapshot()).toMatchObject({ activeReservations: 1, costBasis: "reserved" });
    budget.close();
  });

  it("rejects unknown future and structurally incompatible ledger schemas at open", () => {
    const root = mkdtempSync(join(tmpdir(), "naia-paid-budget-schema-")); roots.push(root);
    const futurePath = join(root, "future.db"); const future = new Database(futurePath);
    future.pragma("user_version = 99"); future.close();
    expect(() => new SqlitePaidCallBudget(futurePath,
      { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1, maxOutputTokens: 1 })).toThrow(/schema version/u);
    const oldPath = join(root, "old.db"); const old = new Database(oldPath);
    old.exec("CREATE TABLE paid_call_reservations(idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL)"); old.close();
    expect(() => new SqlitePaidCallBudget(oldPath,
      { maxPaidCalls: 1, maxUsd: 1, maxInputTokens: 1, maxOutputTokens: 1 })).toThrow(/incompatible/u);
  });
});
