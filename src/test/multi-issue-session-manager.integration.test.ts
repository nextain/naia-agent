import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMultiIssueSessionStore } from "../main/adapters/sqlite-multi-issue-session-store.js";
import { MultiIssueSessionManager } from "../main/app/multi-issue-session-manager.js";
import type { CostEvidence, IssueReport, IssueSnapshot, IssueStartRequest } from "../main/domain/issue-orchestration.js";
import type { MultiIssueSubmission } from "../main/domain/multi-issue-session.js";
import type { SingleIssueExecutionPort } from "../main/ports/multi-issue-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function request(id: string): IssueStartRequest {
  return {
    requestId: id, text: `Implement ${id}`, requiredObligations: [`finish ${id}`], workspacePath: `/work/${id}`,
    naiaBinding: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" },
    moderatorBinding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
    workerProfiles: { balanced: { provider: "openai-codex", model: "gpt-5.6-terra", reasoningEffort: "medium" } },
  };
}

function submission(id: string, reservationUsd?: number, kind: MultiIssueSubmission["source"]["kind"] = "local"): MultiIssueSubmission {
  return { request: request(id), source: { kind, sourceId: `source-${id}`, actorId: "user-1" }, ...(reservationUsd === undefined ? {} : { reservationUsd }) };
}

function report(issueId: string, state: IssueReport["state"] = "completed", cost: CostEvidence = { state: "measured", usd: 0.1, source: "fixture" }): IssueReport {
  return { state, summary: state, issueId, changedFiles: [], verificationPassed: state === "completed", totalCost: cost };
}

class FakeIssues implements SingleIssueExecutionPort {
  readonly snapshots = new Map<string, IssueSnapshot>();
  readonly requestIssues = new Map<string, { digest: string; issueId: string }>();
  readonly starts: string[] = [];
  readonly effects = new Set<string>();
  readonly answers: string[] = [];
  readonly cancellations: string[] = [];
  readonly outcomes = new Map<string, IssueReport>();
  readonly gates = new Map<string, { promise: Promise<IssueReport>; resolve(value: IssueReport): void }>();

  ensure(input: IssueStartRequest): IssueSnapshot {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = this.requestIssues.get(input.requestId);
    if (prior && prior.digest !== digest) throw new Error("request id was reused with different content");
    const issueId = prior?.issueId ?? `issue-${input.requestId}`;
    this.requestIssues.set(input.requestId, { digest, issueId });
    const existing = this.snapshots.get(issueId);
    if (existing) return existing;
    const snapshot: IssueSnapshot = {
      version: 1, requestId: input.requestId, requestDigest: digest, issueId, originalText: input.text,
      requiredObligations: input.requiredObligations, workspacePath: input.workspacePath, state: "accepted",
      naiaBinding: input.naiaBinding, moderatorBinding: input.moderatorBinding, workerProfiles: input.workerProfiles,
      answers: [], receipts: [], createdAt: "2026-08-02T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z",
    };
    this.snapshots.set(issueId, snapshot);
    return snapshot;
  }

  async resume(issueId: string): Promise<IssueReport> {
    this.starts.push(issueId);
    this.effects.add(issueId);
    const gate = this.gates.get(issueId);
    return gate ? gate.promise : this.outcomes.get(issueId) ?? report(issueId);
  }
  async answer(issueId: string, questionId: string, answer: string): Promise<IssueReport> {
    this.answers.push(`${issueId}:${questionId}:${answer}`);
    return this.outcomes.get(issueId) ?? report(issueId);
  }
  async cancel(issueId: string): Promise<IssueReport> {
    this.cancellations.push(issueId);
    return report(issueId, "cancelled");
  }
  snapshot(issueId: string): IssueSnapshot {
    const value = this.snapshots.get(issueId);
    if (!value) throw new Error(`unknown issue: ${issueId}`);
    return value;
  }
  defer(issueId: string): void {
    let resolve!: (value: IssueReport) => void;
    const promise = new Promise<IssueReport>((done) => { resolve = done; });
    this.gates.set(issueId, { promise, resolve });
  }
}

function harness(options: { concurrency?: number; threshold?: number; issues?: FakeIssues } = {}) {
  const root = mkdtempSync(join(tmpdir(), "multi-issue-")); roots.push(root);
  const store = new SqliteMultiIssueSessionStore(join(root, "sessions.db"));
  const issues = options.issues ?? new FakeIssues();
  let id = 0;
  const manager = new MultiIssueSessionManager({
    store, issues, concurrency: options.concurrency ?? 2, autoPump: false,
    ids: () => `session-${++id}`, ownerIds: () => "owner-1",
    now: (() => { let tick = 0; return () => `2026-08-02T00:00:${String(tick++).padStart(2, "0")}Z`; })(),
    ...(options.threshold === undefined ? {} : { aggregateThresholdUsd: options.threshold }),
  });
  return { root, store, issues, manager };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition did not become true");
}

describe("UC-ORCH-002 multi-issue session manager", () => {
  it("ensures and immutably links issue identity before any actor execution", async () => {
    const h = harness();
    const queued = await h.manager.submit(submission("one"));
    expect(queued).toMatchObject({ sessionId: "session-1", issueId: "issue-one", state: "queued" });
    expect(h.issues.starts).toEqual([]);
    await h.manager.pump();
    expect(h.manager.get(queued.sessionId)).toMatchObject({ issueId: "issue-one", state: "completed" });
    h.store.close();
  });

  it("deduplicates identical intake and rejects conflicting request reuse", async () => {
    const h = harness();
    const first = await h.manager.submit(submission("same"));
    const repeated = await h.manager.submit(submission("same"));
    expect(repeated.sessionId).toBe(first.sessionId);
    await expect(h.manager.submit({ ...submission("same"), request: { ...request("same"), text: "different" } })).rejects.toThrow("different content");
    await expect(h.manager.submit({ ...submission("same"), source: { kind: "discord", sourceId: "elsewhere", actorId: "user-2" } })).rejects.toThrow("different content or issue identity");
    await expect(h.manager.submit({ ...submission("same"), reservationUsd: 0.5 })).rejects.toThrow("different content or issue identity");
    expect(h.manager.list()).toHaveLength(1);
    h.store.close();
  });

  it("fills a released slot immediately while preserving bounded FIFO start order", async () => {
    const h = harness({ concurrency: 2 });
    for (const id of ["a", "b", "c"]) { h.issues.defer(`issue-${id}`); await h.manager.submit(submission(id)); }
    const pumping = h.manager.pump();
    await until(() => h.issues.starts.length === 2);
    expect(h.issues.starts).toEqual(["issue-a", "issue-b"]);
    h.issues.gates.get("issue-a")!.resolve(report("issue-a"));
    await until(() => h.issues.starts.length === 3);
    expect(h.issues.starts).toEqual(["issue-a", "issue-b", "issue-c"]);
    h.issues.gates.get("issue-b")!.resolve(report("issue-b"));
    h.issues.gates.get("issue-c")!.resolve(report("issue-c"));
    await pumping;
    expect(h.manager.portfolio().counts.completed).toBe(3);
    h.store.close();
  });

  it("isolates waiting answers and cancellation from sibling sessions", async () => {
    const h = harness({ concurrency: 1 });
    h.issues.outcomes.set("issue-question", { ...report("issue-question", "awaiting_user"), question: { questionId: "q-1", text: "Which parser?" }, verificationPassed: null });
    const waiting = await h.manager.submit(submission("question"));
    const cancelled = await h.manager.submit(submission("cancel"));
    const sibling = await h.manager.submit(submission("sibling"));
    await h.manager.cancel(cancelled.sessionId);
    await h.manager.pump();
    expect(h.manager.get(waiting.sessionId).state).toBe("awaiting_user");
    expect(h.manager.get(cancelled.sessionId).state).toBe("cancelled");
    expect(h.manager.get(sibling.sessionId).state).toBe("completed");
    h.issues.outcomes.set("issue-question", report("issue-question"));
    await h.manager.answer(waiting.sessionId, "q-1", "JSON parser");
    await h.manager.pump();
    expect(h.manager.get(waiting.sessionId).state).toBe("completed");
    expect(h.issues.answers).toEqual(["issue-question:q-1:JSON parser"]);
    h.store.close();
  });

  it("requeues an awaiting session for isolated cancellation", async () => {
    const h = harness({ concurrency: 1 });
    h.issues.outcomes.set("issue-wait-cancel", { ...report("issue-wait-cancel", "awaiting_user"), question: { questionId: "q-cancel", text: "Continue?" }, verificationPassed: null });
    const session = await h.manager.submit(submission("wait-cancel"));
    await h.manager.pump();
    expect(h.manager.get(session.sessionId).state).toBe("awaiting_user");
    await h.manager.cancel(session.sessionId);
    await h.manager.pump();
    expect(h.manager.get(session.sessionId).state).toBe("cancelled");
    expect(h.issues.cancellations).toEqual(["issue-wait-cancel"]);
    h.store.close();
  });

  it("enforces one database scheduler owner with expiry and fenced lifecycle writes", async () => {
    const h = harness();
    const other = new SqliteMultiIssueSessionStore(join(h.root, "sessions.db"));
    expect(h.store.tryAcquireScheduler("owner-a", 1_000, 1_100)).toBe(true);
    expect(other.tryAcquireScheduler("owner-b", 1_050, 1_150)).toBe(false);
    expect(other.tryAcquireScheduler("owner-b", 1_100, 1_200)).toBe(true);
    expect(h.store.renewScheduler("owner-a", 1_101, 1_300)).toBe(false);
    expect(h.store.claimReady({ ownerId: "owner-a", nowMs: 1_101, now: "now", limit: 2 })).toEqual([]);
    other.releaseScheduler("owner-b");
    other.close(); h.store.close();
  });

  it("atomically keeps scheduler ownership when ready work arrives before idle release", async () => {
    const h = harness();
    expect(h.store.tryAcquireScheduler("idle-owner", 1_000, 2_000)).toBe(true);
    await h.manager.submit(submission("wake-up"));
    expect(h.store.releaseSchedulerIfIdle("idle-owner", 1_001)).toBe(false);
    expect(h.store.claimReady({ ownerId: "idle-owner", nowMs: 1_001, now: "2026-08-02T00:00:00Z", limit: 1 }))
      .toHaveLength(1);
    h.store.releaseScheduler("idle-owner");
    h.store.close();
  });

  it("recovers an expired manager process without duplicating the issue effect", async () => {
    const root = mkdtempSync(join(tmpdir(), "multi-issue-recovery-")); roots.push(root);
    const path = join(root, "sessions.db");
    const firstStore = new SqliteMultiIssueSessionStore(path);
    const secondStore = new SqliteMultiIssueSessionStore(path);
    const issues = new FakeIssues();
    issues.defer("issue-restart");
    let nowMs = 1_000;
    const first = new MultiIssueSessionManager({
      store: firstStore, issues, concurrency: 1, autoPump: false, schedulerLeaseMs: 100,
      ids: () => "session-restart", ownerIds: () => "owner-before-crash", clockMs: () => nowMs,
      now: () => "2026-08-02T00:00:00Z",
    });
    const second = new MultiIssueSessionManager({
      store: secondStore, issues, concurrency: 1, autoPump: false, schedulerLeaseMs: 100,
      ids: () => "unused", ownerIds: () => "owner-after-restart", clockMs: () => nowMs,
      now: () => "2026-08-02T00:00:01Z",
    });
    await first.submit(submission("restart"));
    const interrupted = first.pump();
    await until(() => issues.starts.length === 1);
    await second.pump();
    expect(issues.starts).toEqual(["issue-restart"]);

    nowMs = 1_100;
    const recovered = second.pump();
    await until(() => issues.starts.length === 2);
    expect(issues.effects.size).toBe(1);
    issues.gates.get("issue-restart")!.resolve(report("issue-restart"));
    await Promise.all([interrupted, recovered]);
    expect(second.get("session-restart")).toMatchObject({ issueId: "issue-restart", state: "completed" });
    expect(issues.effects.size).toBe(1);
    firstStore.close(); secondStore.close();
  });

  it("applies the exact aggregate reservation predicate and blocks on unavailable settled cost", async () => {
    const h = harness({ concurrency: 2, threshold: 1 });
    for (const id of ["a", "b", "c"]) await h.manager.submit(submission(id, 0.4));
    h.issues.outcomes.set("issue-a", report("issue-a", "completed", { state: "measured", usd: 0.4, source: "fixture" }));
    h.issues.outcomes.set("issue-b", report("issue-b", "completed", { state: "measured", usd: 0.4, source: "fixture" }));
    await h.manager.pump();
    expect(h.manager.list().map((session) => session.state)).toEqual(["completed", "completed", "queued"]);
    expect(h.manager.portfolio()).toMatchObject({ counts: { completed: 2, queued: 1 }, budgetBlocked: true });
    h.store.close();

    const unknown = harness({ concurrency: 1, threshold: 1 });
    unknown.issues.outcomes.set("issue-x", report("issue-x", "outcome_unknown", { state: "unavailable", reason: "missing receipt" }));
    await unknown.manager.submit(submission("x", 0.2));
    await unknown.manager.submit(submission("y", 0.2));
    await unknown.manager.pump();
    expect(unknown.manager.list().map((session) => session.state)).toEqual(["outcome_unknown", "queued"]);
    unknown.store.close();
  });

  it("keeps source provenance transport-neutral and reports grounded portfolio evidence", async () => {
    const h = harness();
    await h.manager.submit(submission("discord-task", undefined, "discord"));
    await h.manager.pump();
    const portfolio = h.manager.portfolio();
    expect(portfolio.sessions[0]?.source).toEqual({ kind: "discord", sourceId: "source-discord-task", actorId: "user-1" });
    expect(portfolio.totalCost).toEqual({ state: "measured", usd: 0.1, source: "sum_of_managed_session_reports" });
    h.store.close();
  });

  it("rejects a missing or sibling issue report as outcome unknown", async () => {
    const h = harness();
    h.issues.outcomes.set("issue-bound", report("issue-sibling"));
    const session = await h.manager.submit(submission("bound"));
    await h.manager.pump();
    expect(h.manager.get(session.sessionId)).toMatchObject({
      issueId: "issue-bound",
      state: "outcome_unknown",
      report: { issueId: "issue-bound", totalCost: { state: "unavailable" } },
    });
    h.store.close();
  });
});
