import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeCodingSessionSkill } from "../main/adapters/coding-session-skill.js";
import { SqliteMultiIssueSessionStore } from "../main/adapters/sqlite-multi-issue-session-store.js";
import { MultiIssueSessionManager } from "../main/app/multi-issue-session-manager.js";
import type { IssueSnapshot } from "../main/domain/issue-orchestration.js";
import type { SingleIssueExecutionPort } from "../main/ports/multi-issue-session.js";

const opts = { signal: new AbortController().signal };

describe("REQ-025 coding-session SQLite bridge", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("preserves the safe session across reopen and cancels it without invoking a model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naia-coding-skill-")); dirs.push(dir);
    const databasePath = join(dir, "sessions.sqlite");
    let ensured = 0;
    const issues: SingleIssueExecutionPort = {
      ensure(request) {
        ensured += 1;
        return { version: 1, requestId: request.requestId, requestDigest: "digest", issueId: "issue-durable",
          originalText: request.text, requiredObligations: request.requiredObligations,
          workspacePath: request.workspacePath, state: "accepted", naiaBinding: request.naiaBinding,
          moderatorBinding: request.moderatorBinding, workerProfiles: request.workerProfiles,
          answers: [], receipts: [], createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z" } satisfies IssueSnapshot;
      },
      async resume() { throw new Error("paid/model path must not run"); },
      async answer() { throw new Error("paid/model path must not run"); },
      async cancel(issueId) { return { state: "cancelled", summary: "cancelled", issueId,
        changedFiles: [], verificationPassed: null, totalCost: { state: "unavailable", reason: "cancelled" } }; },
      snapshot() { throw new Error("not needed"); },
    };
    const context = { workspacePath: dir, actorId: "owner",
      naiaBinding: { provider: "naia", model: "assistant" },
      moderatorBinding: { provider: "codex", model: "luna" },
      workerProfiles: { default: { provider: "codex", model: "worker" } } } as const;

    const firstStore = new SqliteMultiIssueSessionStore(databasePath);
    const firstManager = new MultiIssueSessionManager({ store: firstStore, issues, concurrency: 1,
      autoPump: false, ids: () => "session-durable", ownerIds: () => "owner-first",
      now: () => "2026-08-06T00:00:00.000Z", clockMs: () => 1_000 });
    const firstSkill = makeCodingSessionSkill({ sessions: firstManager, context, requestId: () => "request-durable" });
    const started = await firstSkill.execute({ id: "call-start", name: "start_coding_task",
      args: { task: "implement safely" } }, opts);
    expect(JSON.parse(started.output)).toMatchObject({ sessionId: "session-durable", issueId: "issue-durable", state: "queued" });
    expect(ensured).toBe(1);
    firstStore.close();

    const reopenedStore = new SqliteMultiIssueSessionStore(databasePath);
    const reopenedManager = new MultiIssueSessionManager({ store: reopenedStore, issues, concurrency: 1,
      autoPump: false, ownerIds: () => "owner-second", now: () => "2026-08-06T00:01:00.000Z", clockMs: () => 2_000 });
    const reopenedSkill = makeCodingSessionSkill({ sessions: reopenedManager, context });
    const shown = await reopenedSkill.execute({ id: "call-show", name: "show_coding_task",
      args: { session_id: "session-durable" } }, opts);
    expect(JSON.parse(shown.output)).toMatchObject({ sessionId: "session-durable", state: "queued" });
    const cancelled = await reopenedSkill.execute({ id: "call-cancel", name: "cancel_coding_task",
      args: { session_id: "session-durable" } }, opts);
    expect(JSON.parse(cancelled.output)).toMatchObject({ sessionId: "session-durable", state: "queued", cancellationRequested: true });
    await reopenedManager.pump();
    expect(reopenedManager.get("session-durable")).toMatchObject({ state: "cancelled", cancellationRequested: true });
    expect(ensured).toBe(1);
    reopenedStore.close();
  });
});
