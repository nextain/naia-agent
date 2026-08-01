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
    ...((role === "naia" || role === "reporter") ? { reasoningEffort: "low" }
      : role === "moderator" ? { reasoningEffort: "high" } : role === "worker" ? { reasoningEffort: "medium" } : {}),
    sessionId: `${role}-session-${n}`, executionId: `${role}-execution-${n}`, idempotencyKey: key,
    tokenCountsAvailable: true,
    inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, latencyMs: 5,
    cost: { state: "measured", usd, source: "fixture" },
  };
}

function request(requestId = "request-1", text = "Fix the parser and run its tests"): IssueStartRequest {
  return {
    requestId, text, workspacePath: "/workspace/project",
    naiaBinding: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" },
    moderatorBinding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
    workerProfiles: { balanced: { provider: "fixture", model: "fixture-model", reasoningEffort: "medium" } },
  };
}

function harness(options: { chat?: boolean; question?: boolean; workerThrows?: boolean; unavailableCost?: boolean; badFacingBinding?: boolean; verificationFails?: boolean; workerProfile?: string } = {}) {
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
        plan: { workerTask: "Fix src/parser.ts", workerProfile: options.workerProfile ?? "balanced", acceptanceChecks: ["parser tests pass"], questions },
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
      return { ok: !options.verificationFails, checks: [{ name: "parser tests pass", pass: !options.verificationFails }], receipt: receipt("verifier", input.idempotencyKey, actor) };
    } },
    reporter: { async report(input) {
      calls.reporter += 1; actor += 1;
      expect(input.events.map((event) => event.type)).toContain(options.verificationFails ? "verification_failed" : "verification_passed");
      return {
        report: { state: "completed", summary: "all checks passed", issueId: input.issue.issueId, changedFiles: ["fake-success.ts"], verificationPassed: true },
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
    expect(report).toMatchObject({ state: "completed", summary: "state=completed; changedFiles=1; verification=passed", changedFiles: ["src/parser.ts"], verificationPassed: true });
    expect(report.totalCost).toMatchObject({ state: "measured", usd: 0.05 });
    const snapshot = h.orchestrator.snapshot("issue-0001");
    expect(snapshot.classification?.obligations).toEqual(["fix parser", "run tests"]);
    expect(new Set(snapshot.receipts.map((item) => item.sessionId)).size).toBe(5);
    expect(h.store.events(snapshot.issueId).map((event) => event.type)).toEqual([
      "issue_accepted", "facing_dispatched", "request_classified", "moderator_requested", "moderator_dispatched",
      "plan_ready", "worker_dispatched", "worker_completed", "verification_passed", "reporter_dispatched", "issue_reported",
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
    await expect(resumed.start({
      ...request(), workerProfiles: { economy: { provider: "fixture", model: "cheaper-model", reasoningEffort: "low" } },
    })).rejects.toBeInstanceOf(IssueRequestConflictError);
    await expect(resumed.start(request("request-1", "different task"))).rejects.toBeInstanceOf(IssueRequestConflictError);
    reopened.close();
  });

  it("treats worker-profile map key order as semantically identical", async () => {
    const h = harness();
    const firstRequest = {
      ...request("request-profile-order"),
      workerProfiles: {
        balanced: { provider: "fixture", model: "fixture-model", reasoningEffort: "medium" },
        economy: { provider: "fixture", model: "economy-model", reasoningEffort: "low" },
      },
    };
    const first = await h.orchestrator.start(firstRequest);
    const repeated = await h.orchestrator.start({
      ...firstRequest,
      workerProfiles: {
        economy: firstRequest.workerProfiles.economy,
        balanced: firstRequest.workerProfiles.balanced,
      },
    });
    expect(repeated).toEqual(first);
    expect(h.calls.worker).toBe(1);
    h.store.close();
  });

  it("persists a paid moderator receipt before rejecting an unavailable profile", async () => {
    const h = harness({ workerProfile: "not-configured" });
    const report = await h.orchestrator.start(request("request-profile-rejected"));
    expect(report).toMatchObject({ state: "failed", totalCost: { state: "measured", usd: 0.02 } });
    const snapshot = h.orchestrator.snapshot("issue-0001");
    expect(snapshot.receipts.map((item) => item.role)).toEqual(["naia", "moderator"]);
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("moderator_profile_rejected");
    expect(h.calls.worker).toBe(0);
    h.store.close();
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

  it("overrides a contradictory reporter response with persisted failure evidence", async () => {
    const h = harness({ verificationFails: true });
    const report = await h.orchestrator.start(request("request-failed-report"));
    expect(report).toMatchObject({
      state: "failed", summary: "state=failed; changedFiles=1; verification=failed",
      changedFiles: ["src/parser.ts"], verificationPassed: false,
    });
    h.store.close();
  });

  it("redacts credential-shaped text before durable persistence", async () => {
    const h = harness({ chat: true });
    await h.orchestrator.start(request("request-secret", "rotate api_key=super-secret-value-now"));
    const serialized = JSON.stringify(h.orchestrator.snapshot("issue-0001"));
    expect(serialized).not.toContain("super-secret-value-now");
    expect(serialized).toContain("[REDACTED]");
    h.store.close();
  });

  it("redacts a credential-shaped moderator answer before persistence and relay", async () => {
    const h = harness({ question: true });
    await h.orchestrator.start(request("request-secret-answer"));
    await h.orchestrator.answer("issue-0001", "q-1", "use api_key=answer-secret-value-now");
    const dbPath = join(h.root, "issues.db");
    h.store.close();
    const reopened = new SqliteIssueOrchestrationStore(dbPath);
    const serialized = JSON.stringify(reopened.get("issue-0001"));
    expect(serialized).not.toContain("answer-secret-value-now");
    expect(serialized).toContain("api_key=[REDACTED]");
    reopened.close();
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

  it("does not replay an unreconciled paid actor and marks partial cost unavailable", async () => {
    const h = harness();
    const accepted = h.store.create(request("request-facing-crash"), {
      issueId: "issue-0001", requestDigest: "digest", now: "2026-08-01T00:00:00Z",
    });
    h.store.save({
      expectedVersion: accepted.version,
      snapshot: { ...accepted, state: "classifying", updatedAt: "2026-08-01T00:00:01Z" },
      eventType: "facing_dispatched",
    });
    const report = await h.orchestrator.resume("issue-0001");
    expect(report).toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
    expect(h.calls.facing).toBe(0);
    h.store.close();
  });

  it.each(["moderator_running", "reporter_running"] as const)("does not replay %s after restart", async (state) => {
    const h = harness();
    const accepted = h.store.create(request(`request-${state}`), {
      issueId: "issue-0001", requestDigest: "digest", now: "2026-08-01T00:00:00Z",
    });
    h.store.save({
      expectedVersion: accepted.version,
      snapshot: { ...accepted, state, updatedAt: "2026-08-01T00:00:01Z" },
      eventType: `${state}_fixture`,
    });
    expect(await h.orchestrator.resume("issue-0001")).toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
    expect(h.calls).toEqual({ facing: 0, moderator: 0, worker: 0, verifier: 0, reporter: 0 });
    h.store.close();
  });

  it("rejects cancellation while any paid actor is in flight", () => {
    const h = harness();
    const accepted = h.store.create(request("request-cancel-race"), {
      issueId: "issue-0001", requestDigest: "digest", now: "2026-08-01T00:00:00Z",
    });
    h.store.save({
      expectedVersion: accepted.version,
      snapshot: { ...accepted, state: "reporter_running", updatedAt: "2026-08-01T00:00:01Z" },
      eventType: "reporter_dispatched",
    });
    expect(() => h.orchestrator.cancel("issue-0001")).toThrow("actor lifecycle adapter");
    h.store.close();
  });
});
