import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import { isIssueTerminal, type IssueEvent, type IssueSnapshot, type IssueStartRequest } from "../domain/issue-orchestration.js";
import type { IssueOrchestrationStore } from "../ports/issue-orchestration.js";
import { redactSecrets } from "./redact.js";

type Row = Record<string, unknown>;
const SQLITE_BUSY_RETRY_VIEW = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export class IssueStoreConcurrencyError extends Error {}
export class IssueStoreExecutionClaimError extends Error {}
export class IssueStoreImmutableFieldError extends Error {}
export class IssueStoreTerminalMutationError extends Error {}
export class IssueStoreCancellationWindowError extends Error {}

export class SqliteIssueOrchestrationStore implements IssueOrchestrationStore {
  readonly #db: Database.Database;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#db = new Database(path);
    this.#db.pragma("busy_timeout = 5000");
    withSqliteBusyRetry(() => this.#db.pragma("journal_mode = WAL"));
    this.#db.pragma("foreign_keys = ON");
    withSqliteBusyRetry(() => this.#db.exec(`
      CREATE TABLE IF NOT EXISTS issue_orchestration_snapshots (
        issue_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_orchestration_events (
        issue_id TEXT NOT NULL REFERENCES issue_orchestration_snapshots(issue_id),
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(issue_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS issue_orchestration_execution_claims (
        issue_id TEXT PRIMARY KEY REFERENCES issue_orchestration_snapshots(issue_id),
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `));
    this.chmodPrivateFiles();
  }

  create(request: IssueStartRequest, input: { readonly issueId: string; readonly requestDigest: string; readonly now: string }): IssueSnapshot {
    const result = this.createOrGet(request, input);
    if (!result.created) throw new IssueStoreConcurrencyError("request id already exists");
    return result.snapshot;
  }

  createOrGet(request: IssueStartRequest, input: { readonly issueId: string; readonly requestDigest: string; readonly now: string }): {
    readonly snapshot: IssueSnapshot;
    readonly created: boolean;
  } {
    const candidate = sanitizeForPersistence<IssueSnapshot>({
      version: 1,
      requestId: request.requestId,
      requestDigest: input.requestDigest,
      issueId: input.issueId,
      originalText: request.text,
      requiredObligations: request.requiredObligations,
      workspacePath: request.workspacePath,
      state: "accepted",
      naiaBinding: request.naiaBinding,
      moderatorBinding: request.moderatorBinding,
      workerProfiles: request.workerProfiles,
      answers: [],
      receipts: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
    return this.transaction(() => {
      const established = this.#db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE request_id=?")
        .get(request.requestId) as Row | undefined;
      if (established) return { snapshot: JSON.parse(String(established.snapshot_json)) as IssueSnapshot, created: false };
      this.#db.prepare(`INSERT INTO issue_orchestration_snapshots
        (issue_id, request_id, request_digest, version, state, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        candidate.issueId, candidate.requestId, candidate.requestDigest, candidate.version, candidate.state,
        JSON.stringify(candidate), candidate.createdAt, candidate.updatedAt,
      );
      this.insertEvent(candidate, 1, "issue_accepted", { requestDigest: candidate.requestDigest });
      return { snapshot: candidate, created: true };
    });
  }

  get(issueId: string): IssueSnapshot | undefined {
    const row = this.#db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE issue_id=?").get(issueId) as Row | undefined;
    return row ? JSON.parse(String(row.snapshot_json)) as IssueSnapshot : undefined;
  }

  getByRequestId(requestId: string): IssueSnapshot | undefined {
    const row = this.#db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE request_id=?").get(requestId) as Row | undefined;
    return row ? JSON.parse(String(row.snapshot_json)) as IssueSnapshot : undefined;
  }

  tryAcquireExecution(issueId: string, ownerId: string, nowMs: number, expiresAtMs: number): boolean {
    return this.transaction(() => {
      const changed = this.#db.prepare(`INSERT INTO issue_orchestration_execution_claims (issue_id, owner_id, expires_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET owner_id=excluded.owner_id, expires_at_ms=excluded.expires_at_ms
        WHERE issue_orchestration_execution_claims.owner_id=excluded.owner_id
          OR issue_orchestration_execution_claims.expires_at_ms<=?`).run(issueId, ownerId, expiresAtMs, nowMs);
      return Number(changed.changes) === 1;
    });
  }

  renewExecution(issueId: string, ownerId: string, nowMs: number, expiresAtMs: number): boolean {
    const changed = this.#db.prepare(`UPDATE issue_orchestration_execution_claims SET expires_at_ms=?
      WHERE issue_id=? AND owner_id=? AND expires_at_ms>?`).run(expiresAtMs, issueId, ownerId, nowMs);
    return Number(changed.changes) === 1;
  }

  releaseExecution(issueId: string, ownerId: string): void {
    this.#db.prepare("DELETE FROM issue_orchestration_execution_claims WHERE issue_id=? AND owner_id=?").run(issueId, ownerId);
  }

  requestCancellation(issueId: string, now: string): IssueSnapshot {
    return this.transaction(() => {
      const row = this.#db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE issue_id=?")
        .get(issueId) as Row | undefined;
      if (!row) throw new Error(`unknown issue: ${issueId}`);
      const current = JSON.parse(String(row.snapshot_json)) as IssueSnapshot;
      if (isIssueTerminal(current.state) || current.cancellationRequestedAt) return current;
      if (["worker_running", "verifying", "reporting", "reporter_running"].includes(current.state)) {
        throw new IssueStoreCancellationWindowError("issue has already dispatched its worker");
      }
      const snapshot = sanitizeForPersistence<IssueSnapshot>({
        ...current, version: current.version + 1, cancellationRequestedAt: now, updatedAt: now,
      });
      this.#db.prepare(`UPDATE issue_orchestration_snapshots SET version=?, snapshot_json=?, updated_at=?
        WHERE issue_id=? AND version=?`).run(snapshot.version, JSON.stringify(snapshot), snapshot.updatedAt, issueId, current.version);
      const event = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM issue_orchestration_events WHERE issue_id=?")
        .get(issueId) as Row;
      this.insertEvent(snapshot, Number(event.sequence) + 1, "cancellation_requested", {});
      return snapshot;
    });
  }

  save(input: {
    readonly expectedVersion: number;
    readonly snapshot: IssueSnapshot;
    readonly eventType: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly executionOwnerId?: string;
    readonly executionNowMs?: number;
  }): IssueSnapshot {
    return this.transaction(() => {
      const currentRow = this.#db.prepare("SELECT snapshot_json, version FROM issue_orchestration_snapshots WHERE issue_id=?")
        .get(input.snapshot.issueId) as Row | undefined;
      if (!currentRow) {
        throw new IssueStoreConcurrencyError("issue snapshot changed concurrently");
      }
      const current = JSON.parse(String(currentRow.snapshot_json)) as IssueSnapshot;
      if (Number(currentRow.version) !== input.expectedVersion) {
        if (current.cancellationRequestedAt && !input.snapshot.cancellationRequestedAt) return current;
        throw new IssueStoreConcurrencyError("issue snapshot changed concurrently");
      }
      const claim = this.#db.prepare(`SELECT owner_id, expires_at_ms FROM issue_orchestration_execution_claims
        WHERE issue_id=?`).get(input.snapshot.issueId) as Row | undefined;
      if (claim && (!input.executionOwnerId || String(claim.owner_id) !== input.executionOwnerId
        || Number(claim.expires_at_ms) <= (input.executionNowMs ?? Date.now()))) {
        throw new IssueStoreExecutionClaimError("issue execution claim is missing, expired, or owned by another process");
      }
      if (!claim && input.executionOwnerId) {
        throw new IssueStoreExecutionClaimError("issue execution claim is missing, expired, or owned by another process");
      }
      const version = input.expectedVersion + 1;
      const snapshot = sanitizeForPersistence<IssueSnapshot>({ ...input.snapshot, version });
      assertImmutableFields(current, snapshot);
      if (isIssueTerminal(current.state)) throw new IssueStoreTerminalMutationError("terminal issue snapshots are immutable");
      const changed = this.#db.prepare(`UPDATE issue_orchestration_snapshots
        SET version=?, state=?, snapshot_json=?, updated_at=? WHERE issue_id=? AND version=?`).run(
        version, snapshot.state, JSON.stringify(snapshot), snapshot.updatedAt, snapshot.issueId, input.expectedVersion,
      );
      if (Number(changed.changes) !== 1) throw new IssueStoreConcurrencyError("issue snapshot changed concurrently");
      const row = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM issue_orchestration_events WHERE issue_id=?")
        .get(snapshot.issueId) as Row;
      this.insertEvent(snapshot, Number(row.sequence) + 1, input.eventType, input.payload ?? {});
      return snapshot;
    });
  }

  events(issueId: string): readonly IssueEvent[] {
    return (this.#db.prepare(`SELECT sequence, issue_id, event_type, state, payload_json, created_at
      FROM issue_orchestration_events WHERE issue_id=? ORDER BY sequence`).all(issueId) as Row[]).map((row) => ({
      sequence: Number(row.sequence), issueId: String(row.issue_id), type: String(row.event_type),
      state: String(row.state) as IssueEvent["state"],
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, createdAt: String(row.created_at),
    }));
  }

  close(): void { this.#db.close(); }

  private insertEvent(snapshot: IssueSnapshot, sequence: number, type: string, payload: Readonly<Record<string, unknown>>): void {
    this.#db.prepare(`INSERT INTO issue_orchestration_events
      (issue_id, sequence, event_type, state, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      snapshot.issueId, sequence, type, snapshot.state, JSON.stringify(sanitizeForPersistence(payload)), snapshot.updatedAt,
    );
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      this.chmodPrivateFiles();
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  private chmodPrivateFiles(): void {
    for (const path of [this.#path, `${this.#path}-wal`, `${this.#path}-shm`]) {
      try { chmodSync(path, 0o600); } catch { /* Windows or a not-yet-created SQLite sidecar. */ }
    }
  }
}

function sanitizeForPersistence<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeForPersistence(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, sanitizeForPersistence(item)])) as T;
  }
  return value;
}

function withSqliteBusyRetry<T>(operation: () => T, timeoutMs = 5_000): T {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return operation();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!code.startsWith("SQLITE_BUSY") || Date.now() >= deadline) throw error;
      Atomics.wait(SQLITE_BUSY_RETRY_VIEW, 0, 0, 10);
    }
  }
}

function assertImmutableFields(current: IssueSnapshot, candidate: IssueSnapshot): void {
  const immutable = (snapshot: IssueSnapshot) => ({
    requestId: snapshot.requestId,
    requestDigest: snapshot.requestDigest,
    issueId: snapshot.issueId,
    originalText: snapshot.originalText,
    requiredObligations: snapshot.requiredObligations,
    workspacePath: snapshot.workspacePath,
    naiaBinding: snapshot.naiaBinding,
    moderatorBinding: snapshot.moderatorBinding,
    workerProfiles: snapshot.workerProfiles,
    createdAt: snapshot.createdAt,
  });
  if (stableJson(immutable(current)) !== stableJson(immutable(candidate))) {
    throw new IssueStoreImmutableFieldError("immutable issue identity or request fields changed");
  }
  if (current.dispatchId && candidate.dispatchId !== current.dispatchId) {
    throw new IssueStoreImmutableFieldError("dispatch id changed after being assigned");
  }
  if (current.cancellationRequestedAt && candidate.cancellationRequestedAt !== current.cancellationRequestedAt) {
    throw new IssueStoreImmutableFieldError("cancellation request changed after being recorded");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
