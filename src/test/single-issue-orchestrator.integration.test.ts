import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SingleIssueOrchestrator, IssueQuestionMismatchError, IssueRequestConflictError } from "../main/app/single-issue-orchestrator.js";
import { SqliteIssueOrchestrationStore } from "../main/adapters/sqlite-issue-orchestration-store.js";
import type { ActorReceipt, IssueStartRequest } from "../main/domain/issue-orchestration.js";
import type { SingleIssueOrchestratorDeps } from "../main/app/single-issue-orchestrator.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function receipt(role: ActorReceipt["role"], key: string, n: number, usd = 0.01): ActorReceipt {
  const binding = role === "moderator"
    ? { provider: "openai-codex", model: "gpt-5.6-sol" }
    : role === "naia" || role === "reporter"
      ? { provider: "openai-codex", model: "gpt-5.6-luna" }
      : { provider: "fixture", model: "fixture-model" };
  return {
    role, ...binding,
    sessionId: `${role}-session-${n}`, executionId: `${role}-execution-${n}`, idempotencyKey: key,
    inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, latencyMs: 5,
    cost: { state: "measured", usd, source: "fixture" },
  };
}

function request(requestId = "request-1", text = "Fix the parser and run its tests"): IssueStartRequest {
  return {
    requestId, text, workspacePath: "/workspace/project",
    naiaBinding: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" },
    moderatorBinding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
  };
}

function harness(options: { chat?: boolean; question?: boolean; workerThrows?: boolean; unavailableCost?: boolean; badFacingBinding?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "single-issue-")); roots.push(root);
  const store = new SqliteIssueOrchestrationStore(join(root, "issues.db"));
  const calls = { facing: 0, moderator: 0, worker: 0, verifier: 0, reporter: 0 };
  let actor = 0;
  const deps: SingleIssueOrchestratorDeps = {
    store,
    ids: () => "issue-0001",
    now: (() => { let n = 0; return () => `2026-08-01T00:00:${String(n++).padStart(2, "0")}Z`; })(),
    facing: { async classify(input) {
      calls.facing += 1; actor += 1;
      return {
        classification: options.chat
          ? { kind: "chat", obligations: [], chatReply: "hello" }
          : { kind: "work", obligations: ["fix parser", "run tests"] },
        receipt: options.badFacingBinding
          ? { ...receipt("naia", input.idempotencyKey, actor), model: "gpt-5.6-sol" }
          : receipt("naia", input.idempotencyKey, actor),
      };
    } },
    moderator: { async plan(input) {
      calls.moderator += 1; actor += 1;
      const questions = options.question && input.answers.length === 0 ? [{ questionId: "q-1", text: "Which parser?" }] : [];
      return {
        plan: { workerTask: "Fix src/parser.ts", workerProfile: "balanced", acceptanceChecks: ["parser tests pass"], questions },
        receipt: receipt("moderator", input.idempotencyKey, actor),
      };
    } },
    worker: { async execute(input) {
      calls.worker += 1; actor += 1;
      if (options.workerThrows) throw new Error("transport disappeared after dispatch");
      return {
        ok: true, summary: "parser fixed", worktreePath: "/managed/issue-0001", changedFiles: ["src/parser.ts"],
        receipt: {
          ...receipt("worker", input.dispatchId, actor),
          ...(options.unavailableCost ? { cost: { state: "unavailable" as const, reason: "provider omitted price" } } : {}),
        },
      };
    } },
    verifier: { async verify(input) {
      calls.verifier += 1; actor += 1;
      return { ok: true, checks: [{ name: "parser tests pass", pass: true }], receipt: receipt("verifier", input.idempotencyKey, actor) };
    } },
    reporter: { async report(input) {
      calls.reporter += 1; actor += 1;
      expect(input.events.map((event) => event.type)).toContain("verification_passed");
      return {
        report: { state: "completed", summary: "1 file changed; verification passed", issueId: input.issue.issueId, changedFiles: ["src/parser.ts"], verificationPassed: true },
        receipt: receipt("reporter", input.idempotencyKey, actor),
      };
    } },
  };
  return { root, store, calls, orchestrator: new SingleIssueOrchestrator(deps), deps };
}

describe("UC-ORCH-001 single issue", () => {
  it("keeps chat out of moderator and worker paths", async () => {
    const h = harness({ chat: true });
    const report = await h.orchestrator.start(request("chat-1", "오늘 어때?"));
    expect(report).toMatchObject({ state: "chat", summary: "hello", changedFiles: [] });
    expect(h.calls).toEqual({ facing: 1, moderator: 0, worker: 0, verifier: 0, reporter: 0 });
    h.store.close();
  });

  it("fails closed when an actor receipt does not match its persisted binding", async () => {
    const h = harness({ badFacingBinding: true });
    await expect(h.orchestrator.start(request("bad-binding"))).rejects.toThrow("invalid naia binding receipt");
    expect(h.calls.moderator).toBe(0);
    h.store.close();
  });

  it("preserves obligations, independent identities, verification, and grounded cost", async () => {
    const h = harness();
    const report = await h.orchestrator.start(request());
    expect(report).toMatchObject({ state: "completed", changedFiles: ["src/parser.ts"], verificationPassed: true });
    expect(report.totalCost).toMatchObject({ state: "measured", usd: 0.05 });
    const snapshot = h.orchestrator.snapshot("issue-0001");
    expect(snapshot.classification?.obligations).toEqual(["fix parser", "run tests"]);
    expect(new Set(snapshot.receipts.map((item) => item.sessionId)).size).toBe(5);
    expect(h.store.events(snapshot.issueId).map((event) => event.type)).toEqual([
      "issue_accepted", "request_classified", "moderator_requested", "plan_ready", "worker_dispatched",
      "worker_completed", "verification_passed", "issue_reported",
    ]);
    if (process.platform !== "win32") {
      for (const suffix of ["", "-wal", "-shm"]) expect(statSync(join(h.root, `issues.db${suffix}`)).mode & 0o777).toBe(0o600);
    }
    h.store.close();
  });

  it("preserves a moderator question and resumes only its exact answer", async () => {
    const h = harness({ question: true });
    const pending = await h.orchestrator.start(request());
    expect(pending).toMatchObject({ state: "awaiting_user", question: { questionId: "q-1", text: "Which parser?" } });
    await expect(h.orchestrator.answer("issue-0001", "wrong", "JSON")).rejects.toBeInstanceOf(IssueQuestionMismatchError);
    const done = await h.orchestrator.answer("issue-0001", "q-1", "The JSON parser");
    expect(done.state).toBe("completed");
    expect(h.orchestrator.snapshot("issue-0001").answers).toEqual([{ questionId: "q-1", text: "The JSON parser" }]);
    h.store.close();
  });

  it("deduplicates identical requests across reopen and rejects content drift", async () => {
    const h = harness();
    const first = await h.orchestrator.start(request());
    const repeated = await h.orchestrator.start(request());
    expect(repeated).toEqual(first);
    expect(h.calls.worker).toBe(1);
    h.store.close();
    const reopened = new SqliteIssueOrchestrationStore(join(h.root, "issues.db"));
    const resumed = new SingleIssueOrchestrator({ ...h.deps, store: reopened });
    expect(await resumed.start(request())).toEqual(first);
    await expect(resumed.start(request("request-1", "different task"))).rejects.toBeInstanceOf(IssueRequestConflictError);
    reopened.close();
  });

  it("keeps cancellation and lost worker response honest and propagates unavailable cost", async () => {
    const question = harness({ question: true });
    const pending = await question.orchestrator.start(request());
    expect(question.orchestrator.cancel(pending.issueId!)).toMatchObject({ state: "cancelled" });
    expect(question.calls.worker).toBe(0);
    question.store.close();

    const unknown = harness({ workerThrows: true });
    expect(await unknown.orchestrator.start(request("request-unknown"))).toMatchObject({ state: "outcome_unknown" });
    expect(unknown.calls.verifier).toBe(0);
    unknown.store.close();

    const cost = harness({ unavailableCost: true });
    const report = await cost.orchestrator.start(request("request-cost"));
    expect(report.totalCost).toMatchObject({ state: "unavailable" });
    cost.store.close();
  });

  it("does not re-execute an unreconciled worker after process restart", async () => {
    const h = harness({ question: true });
    await h.orchestrator.start(request("request-restart"));
    const pending = h.orchestrator.snapshot("issue-0001");
    const running = h.store.save({
      expectedVersion: pending.version,
      snapshot: {
        ...pending,
        state: "worker_running",
        dispatchId: "issue-0001:dispatch:1",
        plan: {
          workerTask: "Fix src/parser.ts",
          workerProfile: "balanced",
          acceptanceChecks: ["parser tests pass"],
          questions: [],
        },
        updatedAt: "2026-08-01T00:01:00Z",
      },
      eventType: "worker_dispatched",
      payload: { dispatchId: "issue-0001:dispatch:1" },
    });
    expect(running.state).toBe("worker_running");
    h.store.close();

    const reopened = new SqliteIssueOrchestrationStore(join(h.root, "issues.db"));
    let executeCalls = 0;
    let reconcileCalls = 0;
    const restarted = new SingleIssueOrchestrator({
      ...h.deps,
      store: reopened,
      worker: {
        async execute() { executeCalls += 1; throw new Error("must not execute"); },
        async reconcile(dispatchId) {
          reconcileCalls += 1;
          expect(dispatchId).toBe("issue-0001:dispatch:1");
          return undefined;
        },
      },
    });
    expect(await restarted.resume("issue-0001")).toMatchObject({ state: "outcome_unknown" });
    expect({ executeCalls, reconcileCalls }).toEqual({ executeCalls: 0, reconcileCalls: 1 });
    expect(reopened.events("issue-0001").at(-1)?.type).toBe("worker_outcome_unknown");
    reopened.close();
  });
});
