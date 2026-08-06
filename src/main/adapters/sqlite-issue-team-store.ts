import { chmodSync } from "node:fs";
import Database from "better-sqlite3";
import type { IssueTeamRunSnapshot } from "../domain/issue-team.js";
import type { IssueTeamStore } from "../ports/issue-team.js";

type Row = Record<string, unknown>;
export class IssueTeamStoreConflictError extends Error {}

export class SqliteIssueTeamStore implements IssueTeamStore {
  readonly #db: Database.Database;
  constructor(readonly path: string) {
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS issue_team_runs (
        dispatch_id TEXT PRIMARY KEY, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_team_events (
        dispatch_id TEXT NOT NULL REFERENCES issue_team_runs(dispatch_id), sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(dispatch_id, sequence)
      );
    `);
    this.privateFiles();
  }

  createOrGet(snapshot: IssueTeamRunSnapshot): { readonly snapshot: IssueTeamRunSnapshot; readonly created: boolean } {
    return this.transaction(() => {
      const prior = this.get(snapshot.dispatchId);
      if (prior) {
        if (prior.fingerprint !== snapshot.fingerprint) throw new IssueTeamStoreConflictError("team dispatch fingerprint mismatch");
        return { snapshot: prior, created: false };
      }
      this.#db.prepare("INSERT INTO issue_team_runs(dispatch_id,version,fingerprint,state,snapshot_json) VALUES(?,?,?,?,?)")
        .run(snapshot.dispatchId, snapshot.version, snapshot.fingerprint, snapshot.state, JSON.stringify(snapshot));
      this.#db.prepare("INSERT INTO issue_team_events(dispatch_id,sequence,event_type,state) VALUES(?,?,?,?)")
        .run(snapshot.dispatchId, 1, "team_created", snapshot.state);
      return { snapshot, created: true };
    });
  }

  get(dispatchId: string): IssueTeamRunSnapshot | undefined {
    const row = this.#db.prepare("SELECT snapshot_json FROM issue_team_runs WHERE dispatch_id=?").get(dispatchId) as Row | undefined;
    return row ? JSON.parse(String(row.snapshot_json)) as IssueTeamRunSnapshot : undefined;
  }

  save(input: { readonly expectedVersion: number; readonly snapshot: IssueTeamRunSnapshot; readonly eventType: string }): IssueTeamRunSnapshot {
    return this.transaction(() => {
      const prior = this.get(input.snapshot.dispatchId);
      if (!prior || prior.version !== input.expectedVersion || prior.fingerprint !== input.snapshot.fingerprint) {
        throw new IssueTeamStoreConflictError("team snapshot changed concurrently");
      }
      if (prior.state === "completed" || prior.state === "failed" || prior.state === "cancelled") {
        throw new IssueTeamStoreConflictError("terminal team snapshot is immutable");
      }
      const next = { ...input.snapshot, version: input.expectedVersion + 1 };
      const changed = this.#db.prepare("UPDATE issue_team_runs SET version=?,state=?,snapshot_json=? WHERE dispatch_id=? AND version=?")
        .run(next.version, next.state, JSON.stringify(next), next.dispatchId, input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new IssueTeamStoreConflictError("team snapshot changed concurrently");
      const sequence = Number((this.#db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM issue_team_events WHERE dispatch_id=?")
        .get(next.dispatchId) as Row).value);
      this.#db.prepare("INSERT INTO issue_team_events(dispatch_id,sequence,event_type,state) VALUES(?,?,?,?)")
        .run(next.dispatchId, sequence, input.eventType, next.state);
      return next;
    });
  }

  close(): void { this.#db.close(); }
  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#db.exec("COMMIT"); this.privateFiles(); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  private privateFiles(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) try { chmodSync(file, 0o600); } catch { /* platform */ }
  }
}
