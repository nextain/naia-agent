import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import type { IssueEvent, IssueSnapshot, IssueStartRequest } from "../domain/issue-orchestration.js";
import type { IssueOrchestrationStore } from "../ports/issue-orchestration.js";

type Row = Record<string, unknown>;

export class IssueStoreConcurrencyError extends Error {}

export class SqliteIssueOrchestrationStore implements IssueOrchestrationStore {
  readonly #db: Database.Database;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#db.exec(`
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
    `);
    this.chmodPrivateFiles();
  }

  create(request: IssueStartRequest, input: { readonly issueId: string; readonly requestDigest: string; readonly now: string }): IssueSnapshot {
    const snapshot: IssueSnapshot = {
      version: 1,
      requestId: request.requestId,
      requestDigest: input.requestDigest,
      issueId: input.issueId,
      originalText: request.text,
      workspacePath: request.workspacePath,
      state: "accepted",
      naiaBinding: request.naiaBinding,
      moderatorBinding: request.moderatorBinding,
      workerProfiles: request.workerProfiles,
      answers: [],
      receipts: [],
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.transaction(() => {
      this.#db.prepare(`INSERT INTO issue_orchestration_snapshots
        (issue_id, request_id, request_digest, version, state, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        snapshot.issueId, snapshot.requestId, snapshot.requestDigest, snapshot.version, snapshot.state,
        JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt,
      );
      this.insertEvent(snapshot, 1, "issue_accepted", { requestDigest: snapshot.requestDigest });
    });
    return snapshot;
  }

  get(issueId: string): IssueSnapshot | undefined {
    const row = this.#db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE issue_id=?").get(issueId) as Row | undefined;
    return row ? JSON.parse(String(row.snapshot_json)) as IssueSnapshot : undefined;
  }

  getByRequestId(requestId: string): IssueSnapshot | undefined {
    const row = this.#db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE request_id=?").get(requestId) as Row | undefined;
    return row ? JSON.parse(String(row.snapshot_json)) as IssueSnapshot : undefined;
  }

  save(input: {
    readonly expectedVersion: number;
    readonly snapshot: IssueSnapshot;
    readonly eventType: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }): IssueSnapshot {
    return this.transaction(() => {
      const version = input.expectedVersion + 1;
      const snapshot: IssueSnapshot = { ...input.snapshot, version };
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
      snapshot.issueId, sequence, type, snapshot.state, JSON.stringify(payload), snapshot.updatedAt,
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
