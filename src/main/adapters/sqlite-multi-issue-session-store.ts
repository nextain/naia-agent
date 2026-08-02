import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import type { IssueReport } from "../domain/issue-orchestration.js";
import { isManagedSessionTerminal, type ManagedIssueSession, type MultiIssueSubmission, type PendingSessionAnswer } from "../domain/multi-issue-session.js";
import type { MultiIssueSessionStore } from "../ports/multi-issue-session.js";
import { redactSecrets } from "./redact.js";

type Row = Record<string, unknown>;

export class MultiIssueSessionConflictError extends Error {}
export class MultiIssueSchedulerClaimError extends Error {}
export class MultiIssueCommandError extends Error {}

export class SqliteMultiIssueSessionStore implements MultiIssueSessionStore {
  readonly #db: Database.Database;
  constructor(readonly path: string) {
    this.#db = new Database(path);
    this.#db.pragma("busy_timeout = 5000");
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS multi_issue_sessions (
        session_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        issue_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        ready_priority INTEGER NOT NULL,
        ready_sequence INTEGER NOT NULL,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multi_issue_ready_sequence (
        value INTEGER PRIMARY KEY AUTOINCREMENT
      );
      CREATE TABLE IF NOT EXISTS multi_issue_scheduler_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multi_issue_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.chmodPrivateFiles();
  }

  createOrGet(input: { readonly submission: MultiIssueSubmission; readonly issue: import("../domain/issue-orchestration.js").IssueSnapshot; readonly sessionId: string; readonly now: string }): { readonly snapshot: ManagedIssueSession; readonly created: boolean } {
    return this.transaction(() => {
      validateSubmission(input.submission);
      const existing = this.#db.prepare("SELECT snapshot_json FROM multi_issue_sessions WHERE request_id=?")
        .get(input.submission.request.requestId) as Row | undefined;
      if (existing) {
        const snapshot = parseSession(existing.snapshot_json);
        if (snapshot.requestDigest !== input.issue.requestDigest || snapshot.issueId !== input.issue.issueId
          || snapshot.workspacePath !== input.submission.request.workspacePath
          || JSON.stringify(snapshot.source) !== JSON.stringify(sanitize(input.submission.source))
          || snapshot.reservationUsd !== input.submission.reservationUsd) {
          throw new MultiIssueSessionConflictError("request id was reused with different content or issue identity");
        }
        return { snapshot, created: false };
      }
      const readySequence = this.nextReadySequence();
      const snapshot = sanitize<ManagedIssueSession>({
        version: 1,
        sessionId: input.sessionId,
        requestId: input.submission.request.requestId,
        requestDigest: input.issue.requestDigest,
        issueId: input.issue.issueId,
        workspacePath: input.submission.request.workspacePath,
        source: input.submission.source,
        state: "queued",
        readyPriority: "normal",
        readySequence,
        cancellationRequested: false,
        ...(input.submission.reservationUsd === undefined ? {} : { reservationUsd: input.submission.reservationUsd }),
        createdAt: input.now,
        updatedAt: input.now,
      });
      this.#db.prepare(`INSERT INTO multi_issue_sessions
        (session_id, request_id, request_digest, issue_id, state, ready_priority, ready_sequence, version, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        snapshot.sessionId, snapshot.requestId, snapshot.requestDigest, snapshot.issueId, snapshot.state,
        priorityNumber(snapshot.readyPriority), snapshot.readySequence, snapshot.version, JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt,
      );
      this.insertEvent(snapshot, "session_queued", { sourceKind: snapshot.source.kind });
      return { snapshot, created: true };
    });
  }

  get(sessionId: string): ManagedIssueSession | undefined {
    const row = this.#db.prepare("SELECT snapshot_json FROM multi_issue_sessions WHERE session_id=?").get(sessionId) as Row | undefined;
    return row ? parseSession(row.snapshot_json) : undefined;
  }

  list(): readonly ManagedIssueSession[] {
    return (this.#db.prepare("SELECT snapshot_json FROM multi_issue_sessions ORDER BY ready_sequence, session_id").all() as Row[])
      .map((row) => parseSession(row.snapshot_json));
  }

  requestCancellation(sessionId: string, now: string): ManagedIssueSession {
    return this.transaction(() => {
      const current = this.required(sessionId);
      if (isManagedSessionTerminal(current.state) || current.cancellationRequested) return current;
      const requeue = current.state === "awaiting_user";
      const next: ManagedIssueSession = {
        ...current, version: current.version + 1, cancellationRequested: true, updatedAt: now,
        ...(requeue ? { state: "queued", readyPriority: "normal", readySequence: this.nextReadySequence() } : {}),
      };
      this.write(next);
      this.insertEvent(next, "cancellation_requested", {});
      return next;
    });
  }

  queueAnswer(sessionId: string, answer: PendingSessionAnswer, now: string): ManagedIssueSession {
    if (!answer.text.trim()) throw new MultiIssueCommandError("answer is required");
    return this.transaction(() => {
      const current = this.required(sessionId);
      if (current.state !== "awaiting_user" || current.report?.question?.questionId !== answer.questionId) {
        throw new MultiIssueCommandError("answer does not match the pending session question");
      }
      const next = sanitize<ManagedIssueSession>({
        ...current, version: current.version + 1, state: "queued", readyPriority: "normal",
        readySequence: this.nextReadySequence(), pendingAnswer: answer, updatedAt: now,
      });
      this.write(next);
      this.insertEvent(next, "answer_queued", { questionId: answer.questionId });
      return next;
    });
  }

  tryAcquireScheduler(ownerId: string, nowMs: number, expiresAtMs: number): boolean {
    return this.transaction(() => Number(this.#db.prepare(`INSERT INTO multi_issue_scheduler_lease (singleton, owner_id, expires_at_ms)
      VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id, expires_at_ms=excluded.expires_at_ms
      WHERE multi_issue_scheduler_lease.owner_id=excluded.owner_id OR multi_issue_scheduler_lease.expires_at_ms<=?`)
      .run(ownerId, expiresAtMs, nowMs).changes) === 1);
  }

  renewScheduler(ownerId: string, nowMs: number, expiresAtMs: number): boolean {
    return Number(this.#db.prepare(`UPDATE multi_issue_scheduler_lease SET expires_at_ms=?
      WHERE singleton=1 AND owner_id=? AND expires_at_ms>?`).run(expiresAtMs, ownerId, nowMs).changes) === 1;
  }

  releaseScheduler(ownerId: string): void {
    this.#db.prepare("DELETE FROM multi_issue_scheduler_lease WHERE singleton=1 AND owner_id=?").run(ownerId);
  }

  recoverRunning(ownerId: string, nowMs: number, now: string): number {
    return this.transaction(() => {
      this.assertScheduler(ownerId, nowMs);
      const running = this.list().filter((session) => session.state === "running" && session.runOwnerId !== ownerId);
      for (const current of running) {
        const next: ManagedIssueSession = {
          ...current, version: current.version + 1, state: "queued", readyPriority: "recovery",
          readySequence: this.nextReadySequence(), runOwnerId: undefined, updatedAt: now,
        };
        this.write(next);
        this.insertEvent(next, "session_recovery_queued", {});
      }
      return running.length;
    });
  }

  claimReady(input: { readonly ownerId: string; readonly nowMs: number; readonly now: string; readonly limit: number; readonly aggregateThresholdUsd?: number }): readonly ManagedIssueSession[] {
    return this.transaction(() => {
      if (!this.schedulerOwned(input.ownerId, input.nowMs)) return [];
      const sessions = this.list();
      const running = sessions.filter((session) => session.state === "running");
      let capacity = Math.max(0, input.limit - running.length);
      if (capacity === 0) return [];
      let committed = 0;
      if (input.aggregateThresholdUsd !== undefined) {
        for (const session of sessions.filter((candidate) => isManagedSessionTerminal(candidate.state))) {
          if (!session.report || session.report.totalCost.state === "unavailable") return [];
          committed += session.report.totalCost.usd;
        }
        for (const session of running) {
          if (session.reservationUsd === undefined) return [];
          committed += session.reservationUsd;
        }
      }
      const ready = sessions.filter((session) => session.state === "queued")
        .sort((left, right) => priorityNumber(left.readyPriority) - priorityNumber(right.readyPriority)
          || left.readySequence - right.readySequence || left.sessionId.localeCompare(right.sessionId));
      const claimed: ManagedIssueSession[] = [];
      for (const current of ready) {
        if (capacity === 0) break;
        if (input.aggregateThresholdUsd !== undefined) {
          if (current.reservationUsd === undefined || committed + current.reservationUsd > input.aggregateThresholdUsd) break;
          committed += current.reservationUsd;
        }
        const next: ManagedIssueSession = {
          ...current, version: current.version + 1, state: "running", runOwnerId: input.ownerId, updatedAt: input.now,
        };
        this.write(next);
        this.insertEvent(next, "session_admitted", {});
        claimed.push(next);
        capacity -= 1;
      }
      return claimed;
    });
  }

  settle(sessionId: string, ownerId: string, nowMs: number, now: string, report: IssueReport): ManagedIssueSession | undefined {
    return this.transaction(() => {
      if (!this.schedulerOwned(ownerId, nowMs)) return undefined;
      const current = this.required(sessionId);
      if (isManagedSessionTerminal(current.state) || current.state === "awaiting_user") return current;
      if (current.state !== "running" || current.runOwnerId !== ownerId) throw new MultiIssueSchedulerClaimError("session is not owned by scheduler");
      const next: ManagedIssueSession = sanitize({
        ...current,
        version: current.version + 1,
        state: report.state,
        report,
        pendingAnswer: undefined,
        runOwnerId: undefined,
        updatedAt: now,
      });
      this.write(next);
      this.insertEvent(next, "session_settled", { outcome: report.state });
      return next;
    });
  }

  close(): void { this.#db.close(); }

  private required(sessionId: string): ManagedIssueSession {
    const snapshot = this.get(sessionId);
    if (!snapshot) throw new MultiIssueCommandError(`unknown session: ${sessionId}`);
    return snapshot;
  }

  private assertScheduler(ownerId: string, nowMs: number): void {
    if (!this.schedulerOwned(ownerId, nowMs)) {
      throw new MultiIssueSchedulerClaimError("scheduler lease is missing, expired, or owned by another process");
    }
  }

  private schedulerOwned(ownerId: string, nowMs: number): boolean {
    const lease = this.#db.prepare("SELECT owner_id, expires_at_ms FROM multi_issue_scheduler_lease WHERE singleton=1").get() as Row | undefined;
    return Boolean(lease && String(lease.owner_id) === ownerId && Number(lease.expires_at_ms) > nowMs);
  }

  private nextReadySequence(): number {
    return Number(this.#db.prepare("INSERT INTO multi_issue_ready_sequence DEFAULT VALUES").run().lastInsertRowid);
  }

  private write(snapshot: ManagedIssueSession): void {
    const changed = this.#db.prepare(`UPDATE multi_issue_sessions SET state=?, ready_priority=?, ready_sequence=?, version=?,
      snapshot_json=?, updated_at=? WHERE session_id=?`).run(
      snapshot.state, priorityNumber(snapshot.readyPriority), snapshot.readySequence, snapshot.version,
      JSON.stringify(snapshot), snapshot.updatedAt, snapshot.sessionId,
    );
    if (Number(changed.changes) !== 1) throw new MultiIssueSessionConflictError("session changed concurrently");
  }

  private insertEvent(snapshot: ManagedIssueSession, type: string, payload: Readonly<Record<string, unknown>>): void {
    this.#db.prepare(`INSERT INTO multi_issue_events (session_id, event_type, state, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(snapshot.sessionId, type, snapshot.state, JSON.stringify(sanitize(payload)), snapshot.updatedAt);
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      this.chmodPrivateFiles();
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  private chmodPrivateFiles(): void {
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try { chmodSync(candidate, 0o600); } catch { /* Windows or absent sidecar. */ }
    }
  }
}

function parseSession(value: unknown): ManagedIssueSession {
  const parsed = JSON.parse(String(value)) as Partial<ManagedIssueSession>;
  const states = ["queued", "running", "awaiting_user", "chat", "completed", "failed", "cancelled", "outcome_unknown"];
  if (!parsed.sessionId || !parsed.requestId || !parsed.issueId || !parsed.requestDigest
    || !states.includes(String(parsed.state)) || !Number.isSafeInteger(parsed.version) || !Number.isSafeInteger(parsed.readySequence)
    || !parsed.source || !["local", "discord", "shell", "other"].includes(String(parsed.source.kind))) {
    throw new MultiIssueSessionConflictError("persisted multi-issue session is invalid");
  }
  return parsed as ManagedIssueSession;
}

function priorityNumber(priority: ManagedIssueSession["readyPriority"]): number { return priority === "recovery" ? 0 : 1; }

function validateSubmission(submission: MultiIssueSubmission): void {
  const source = submission.source;
  if (!(["local", "discord", "shell", "other"] as const).includes(source.kind)
    || !validSourceId(source.sourceId) || !validSourceId(source.actorId)) throw new MultiIssueCommandError("source identity is required");
  if (submission.reservationUsd !== undefined && (!Number.isFinite(submission.reservationUsd) || submission.reservationUsd < 0)) {
    throw new MultiIssueCommandError("reservation must be a non-negative finite amount");
  }
}

function validSourceId(value: string): boolean {
  return value.length > 0 && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sanitize<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitize(item)])) as T;
  }
  return value;
}
