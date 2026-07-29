import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  SUPERVISOR_REPORT_INTERVAL_MS,
  type DurableDispatchCommand,
  type DurableRunRequest,
  type DurableSupervisorSnapshot,
  type DurableWorkerEvent,
} from "../domain/durable-supervisor.js";
import type { DurableSupervisorStore } from "../ports/durable-supervisor.js";

interface SqliteSupervisorStoreOptions {
  readonly leaseMs?: number;
  readonly baseRetryMs?: number;
  readonly reportIntervalMs?: number;
  /** Supervisor-owned clock. Worker payloads never provide authoritative time. */
  readonly now?: () => number;
}

type DbRow = Record<string, unknown>;

export class SqliteDurableSupervisorStore implements DurableSupervisorStore {
  private readonly db: Database.Database;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly reportIntervalMs: number;
  private readonly now: () => number;

  constructor(path: string, options: SqliteSupervisorStoreOptions = {}) {
    this.db = new Database(path);
    this.leaseMs = positiveInteger(options.leaseMs, 60_000);
    this.baseRetryMs = positiveInteger(options.baseRetryMs, 1_000);
    this.reportIntervalMs = positiveInteger(options.reportIntervalMs, SUPERVISOR_REPORT_INTERVAL_MS);
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_runs (
        run_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','completed','failed')),
        next_report_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervisor_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES supervisor_runs(run_id),
        attempt_no INTEGER NOT NULL,
        execution_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('queued','running','completed','timed_out')),
        lease_token TEXT,
        lease_expires_at INTEGER,
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id, attempt_no)
      );
      CREATE TABLE IF NOT EXISTS supervisor_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES supervisor_runs(run_id),
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supervisor_outbox (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES supervisor_runs(run_id),
        attempt_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('execute','progress_report')),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','dispatching','acked')),
        available_at INTEGER NOT NULL,
        dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        dispatched_at INTEGER,
        acked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervisor_outbox_due
        ON supervisor_outbox(state, available_at, created_at);
      CREATE INDEX IF NOT EXISTS supervisor_attempt_lease
        ON supervisor_attempts(state, lease_expires_at);
    `);
  }

  startRun(request: DurableRunRequest): void {
    requireId(request.runId, "runId");
    if (!request.task.trim()) throw new Error("task must not be empty");
    const now = this.now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO supervisor_runs
        (run_id, task, state, next_report_at, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, ?)`)
        .run(request.runId, request.task, now + this.reportIntervalMs, now, now);
      this.createAttempt(request.runId, request.task, 1, now, now);
      this.event(request.runId, null, "run_started", { task: request.task }, now);
    });
  }

  recover(): void {
    const now = this.now();
    this.transaction(() => {
      const interrupted = this.db.prepare(
        "SELECT command_id, run_id, attempt_id FROM supervisor_outbox WHERE state='dispatching'",
      ).all() as DbRow[];
      this.db.prepare(`UPDATE supervisor_outbox
        SET state='pending', available_at=?, updated_at=? WHERE state='dispatching'`)
        .run(now, now);
      for (const row of interrupted) {
        this.event(String(row.run_id), nullableString(row.attempt_id), "dispatch_recovered", {
          commandId: String(row.command_id),
        }, now);
      }
    });
    this.advanceTime();
  }

  advanceTime(): void {
    const now = this.now();
    this.transaction(() => {
      const expired = this.db.prepare(`SELECT a.attempt_id, a.run_id, a.attempt_no, r.task
        FROM supervisor_attempts a JOIN supervisor_runs r ON r.run_id=a.run_id
        WHERE a.state='running' AND a.lease_expires_at IS NOT NULL AND a.lease_expires_at<=?
          AND r.state='running'`).all(now) as DbRow[];
      for (const row of expired) {
        const attemptId = String(row.attempt_id);
        const runId = String(row.run_id);
        const attemptNo = Number(row.attempt_no);
        this.timeoutAttempt(runId, attemptId, attemptNo, String(row.task), now);
      }

      const dueRuns = this.db.prepare(`SELECT run_id, next_report_at FROM supervisor_runs
        WHERE state='running' AND next_report_at IS NOT NULL AND next_report_at<=?`).all(now) as DbRow[];
      for (const row of dueRuns) {
        const runId = String(row.run_id);
        let next = Number(row.next_report_at);
        while (next <= now) {
          const dueAt = next;
          const commandId = `${runId}:report:${dueAt}`;
          this.db.prepare(`INSERT OR IGNORE INTO supervisor_outbox
            (command_id, run_id, attempt_id, kind, idempotency_key, payload_json, state,
             available_at, created_at, updated_at)
            VALUES (?, ?, NULL, 'progress_report', ?, ?, 'pending', ?, ?, ?)`)
            .run(commandId, runId, commandId, JSON.stringify({ runId, dueAt }), dueAt, now, now);
          this.event(runId, null, "progress_report_due", { dueAt }, now);
          next += this.reportIntervalMs;
        }
        this.db.prepare("UPDATE supervisor_runs SET next_report_at=?, updated_at=? WHERE run_id=?")
          .run(next, now, runId);
      }
    });
  }

  claimCommand(): DurableDispatchCommand | null {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT command_id, idempotency_key, run_id, attempt_id, kind, payload_json
        FROM supervisor_outbox WHERE state='pending' AND available_at<=?
        ORDER BY available_at, created_at, command_id LIMIT 1`).get(now) as DbRow | undefined;
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE supervisor_outbox
        SET state='dispatching', dispatch_attempts=dispatch_attempts+1, dispatched_at=?, updated_at=?
        WHERE command_id=? AND state='pending'`).run(now, now, String(row.command_id));
      if (Number(changed.changes) !== 1) return null;
      this.event(String(row.run_id), nullableString(row.attempt_id), "dispatch_claimed", {
        commandId: String(row.command_id), idempotencyKey: String(row.idempotency_key),
      }, now);
      return {
        commandId: String(row.command_id),
        idempotencyKey: String(row.idempotency_key),
        runId: String(row.run_id),
        attemptId: nullableString(row.attempt_id),
        kind: String(row.kind) as DurableDispatchCommand["kind"],
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      };
    });
  }

  acknowledgeCommand(commandId: string): void {
    const now = this.now();
    this.transaction(() => {
      const row = this.db.prepare(`SELECT run_id, attempt_id, kind FROM supervisor_outbox
        WHERE command_id=? AND state='dispatching'`).get(commandId) as DbRow | undefined;
      if (!row) return;
      this.db.prepare(`UPDATE supervisor_outbox SET state='acked', acked_at=?, updated_at=?
        WHERE command_id=? AND state='dispatching'`).run(now, now, commandId);
      const attemptId = nullableString(row.attempt_id);
      if (String(row.kind) === "execute" && attemptId) {
        this.db.prepare(`UPDATE supervisor_attempts SET state='running', lease_expires_at=?,
          next_retry_at=NULL, updated_at=? WHERE attempt_id=? AND state='queued'`)
          .run(now + this.leaseMs, now, attemptId);
      }
      this.event(String(row.run_id), attemptId, "dispatch_acked", { commandId }, now);
    });
  }

  deferCommand(commandId: string): void {
    const now = this.now();
    this.transaction(() => {
      const row = this.db.prepare(`SELECT run_id, attempt_id, dispatch_attempts FROM supervisor_outbox
        WHERE command_id=? AND state='dispatching'`).get(commandId) as DbRow | undefined;
      if (!row) return;
      const availableAt = now + this.retryDelay(Number(row.dispatch_attempts));
      this.db.prepare(`UPDATE supervisor_outbox SET state='pending', available_at=?, updated_at=?
        WHERE command_id=? AND state='dispatching'`).run(availableAt, now, commandId);
      this.event(String(row.run_id), nullableString(row.attempt_id), "dispatch_deferred", {
        commandId, availableAt,
      }, now);
    });
  }

  heartbeat(event: DurableWorkerEvent): boolean {
    return this.workerEvent(event, "heartbeat", (now) => {
      this.db.prepare("UPDATE supervisor_attempts SET lease_expires_at=?, updated_at=? WHERE attempt_id=?")
        .run(now + this.leaseMs, now, event.attemptId);
    });
  }

  complete(event: DurableWorkerEvent & { readonly ok: boolean; readonly summary?: string }): boolean {
    return this.workerEvent(event, "attempt_completed", (now) => {
      this.db.prepare(`UPDATE supervisor_attempts SET state='completed', lease_token=NULL,
        lease_expires_at=NULL, updated_at=? WHERE attempt_id=?`).run(now, event.attemptId);
      this.db.prepare(`UPDATE supervisor_runs SET state=?, next_report_at=NULL, updated_at=? WHERE run_id=?`)
        .run(event.ok ? "completed" : "failed", now, event.runId);
    }, { ok: event.ok, summary: event.summary ?? null });
  }

  snapshot(runId: string): DurableSupervisorSnapshot {
    const run = this.db.prepare("SELECT state, next_report_at FROM supervisor_runs WHERE run_id=?")
      .get(runId) as DbRow | undefined;
    if (!run) throw new Error(`unknown run: ${runId}`);
    const attempts = this.db.prepare(`SELECT attempt_id, attempt_no, execution_id, state, lease_token,
      lease_expires_at, next_retry_at FROM supervisor_attempts WHERE run_id=? ORDER BY attempt_no`)
      .all(runId) as DbRow[];
    const outbox = this.db.prepare(`SELECT command_id, idempotency_key, kind, state, available_at
      FROM supervisor_outbox WHERE run_id=? ORDER BY created_at, command_id`).all(runId) as DbRow[];
    const events = this.db.prepare("SELECT event_type FROM supervisor_events WHERE run_id=? ORDER BY event_id")
      .all(runId) as DbRow[];
    return {
      runState: String(run.state) as DurableSupervisorSnapshot["runState"],
      nextReportAt: nullableNumber(run.next_report_at),
      attempts: attempts.map((row) => ({
        attemptId: String(row.attempt_id), attemptNo: Number(row.attempt_no),
        executionId: String(row.execution_id),
        state: String(row.state) as DurableSupervisorSnapshot["attempts"][number]["state"],
        leaseToken: nullableString(row.lease_token), leaseExpiresAt: nullableNumber(row.lease_expires_at),
        nextRetryAt: nullableNumber(row.next_retry_at),
      })),
      outbox: outbox.map((row) => ({
        commandId: String(row.command_id), idempotencyKey: String(row.idempotency_key),
        kind: String(row.kind) as DurableSupervisorSnapshot["outbox"][number]["kind"],
        state: String(row.state) as DurableSupervisorSnapshot["outbox"][number]["state"],
        availableAt: Number(row.available_at),
      })),
      eventTypes: events.map((row) => String(row.event_type)),
    };
  }

  close(): void { this.db.close(); }

  private createAttempt(runId: string, task: string, attemptNo: number, availableAt: number, now: number): void {
    const attemptId = `${runId}:attempt:${attemptNo}`;
    const executionId = `${runId}:execution:${attemptNo}`;
    const leaseToken = randomUUID();
    this.db.prepare(`INSERT INTO supervisor_attempts
      (attempt_id, run_id, attempt_no, execution_id, state, lease_token, next_retry_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(attemptId, runId, attemptNo, executionId, leaseToken,
        availableAt > now ? availableAt : null, now, now);
    const commandId = `${attemptId}:execute`;
    this.db.prepare(`INSERT INTO supervisor_outbox
      (command_id, run_id, attempt_id, kind, idempotency_key, payload_json, state,
       available_at, created_at, updated_at)
      VALUES (?, ?, ?, 'execute', ?, ?, 'pending', ?, ?, ?)`)
      .run(commandId, runId, attemptId, executionId,
        JSON.stringify({ runId, attemptId, executionId, leaseToken, task }),
        availableAt, now, now);
    this.event(runId, attemptId, "attempt_queued", { attemptNo, executionId, availableAt }, now);
  }

  private workerEvent(
    input: DurableWorkerEvent,
    eventType: string,
    mutation: (now: number) => void,
    payload: Record<string, unknown> = {},
  ): boolean {
    const now = this.now();
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT a.run_id, a.execution_id, a.attempt_no, a.state,
          a.lease_token, a.lease_expires_at, r.task
        FROM supervisor_attempts a JOIN supervisor_runs r ON r.run_id=a.run_id
        WHERE a.attempt_id=?`).get(input.attemptId) as DbRow | undefined;
      const identityMatches = !!row
        && String(row.run_id) === input.runId
        && String(row.execution_id) === input.executionId
        && String(row.state) === "running"
        && String(row.lease_token) === input.leaseToken;
      const leaseExpiresAt = row ? nullableNumber(row.lease_expires_at) : null;
      if (identityMatches && leaseExpiresAt !== null && leaseExpiresAt <= now) {
        this.timeoutAttempt(input.runId, input.attemptId, Number(row!.attempt_no), String(row!.task), now);
      }
      const valid = identityMatches && leaseExpiresAt !== null && leaseExpiresAt > now;
      if (!valid) {
        if (row) this.event(input.runId, input.attemptId, "worker_event_rejected", { eventType }, now);
        return false;
      }
      mutation(now);
      this.event(input.runId, input.attemptId, eventType, payload, now);
      return true;
    });
  }

  private retryDelay(attempt: number): number {
    return this.baseRetryMs * (2 ** Math.min(Math.max(0, attempt - 1), 6));
  }

  private timeoutAttempt(runId: string, attemptId: string, attemptNo: number, task: string, now: number): boolean {
    const retryAt = now + this.retryDelay(attemptNo);
    const changed = this.db.prepare(`UPDATE supervisor_attempts
      SET state='timed_out', lease_token=NULL, lease_expires_at=NULL, next_retry_at=?, updated_at=?
      WHERE attempt_id=? AND state='running'`).run(retryAt, now, attemptId);
    if (Number(changed.changes) !== 1) return false;
    this.event(runId, attemptId, "attempt_timed_out", { retryAt }, now);
    this.createAttempt(runId, task, attemptNo + 1, retryAt, now);
    return true;
  }

  private event(runId: string, attemptId: string | null, eventType: string, payload: unknown, now: number): void {
    this.db.prepare(`INSERT INTO supervisor_events
      (run_id, attempt_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, attemptId, eventType, JSON.stringify(payload), now);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function requireId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`invalid ${name}`);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
