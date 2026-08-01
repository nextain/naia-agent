import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SingleIssueOrchestrator, IssueQuestionMismatchError, IssueRequestConflictError } from "../main/app/single-issue-orchestrator.js";
import {
  IssueStoreImmutableFieldError,
  IssueStoreExecutionClaimError,
  IssueStoreSnapshotContractError,
  IssueStoreTerminalMutationError,
  SqliteIssueOrchestrationStore,
} from "../main/adapters/sqlite-issue-orchestration-store.js";
import { groundedIssueCommentary, type ActorReceipt, type IssueStartRequest } from "../main/domain/issue-orchestration.js";
import type { SingleIssueOrchestratorDeps } from "../main/app/single-issue-orchestrator.js";
import { IssueActorResultError } from "../main/ports/issue-orchestration.js";

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

function request(requestId = "request-1", text = "Fix the parser and run its tests",
  requiredObligations: readonly string[] = ["fix parser", "run tests"]): IssueStartRequest {
  return {
    requestId, text, requiredObligations, workspacePath: "/workspace/project",
    naiaBinding: { provider: "openai-codex", model: "gpt-5.6-luna", reasoningEffort: "low" },
    moderatorBinding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
    workerProfiles: { balanced: { provider: "fixture", model: "fixture-model", reasoningEffort: "medium" } },
  };
}

function harness(options: { chat?: boolean; droppedObligation?: boolean; question?: boolean; multipleQuestions?: boolean; workerThrows?: boolean; unavailableCost?: boolean; badFacingBinding?: boolean; verificationFails?: boolean; verifierThrows?: boolean; badVerifierReceipt?: boolean; workerProfile?: string; malformedReceipt?: "cached" | "cost" | "unavailable"; rejectedActorResult?: boolean; rejectedWorkerResult?: boolean; contradictoryReporter?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "single-issue-")); roots.push(root);
  const store = new SqliteIssueOrchestrationStore(join(root, "issues.db"));
  const calls = { facing: 0, moderator: 0, worker: 0, verifier: 0, reporter: 0 };
  let seenFacingText = "";
  let seenWorkerObligations: readonly string[] = [];
  let actor = 0;
  const deps: SingleIssueOrchestratorDeps = {
    store,
    ids: () => "issue-0001",
    now: (() => { let n = 0; return () => `2026-08-01T00:00:${String(n++).padStart(2, "0")}Z`; })(),
    facing: { async classify(input) {
      calls.facing += 1; actor += 1;
      seenFacingText = input.text;
      return {
        classification: options.chat
          ? { kind: "chat", obligations: [], chatReply: "hello" }
          : { kind: "work", obligations: options.droppedObligation ? ["fix parser"] : ["fix parser", "run tests"] },
        receipt: options.badFacingBinding
          ? { ...receipt("naia", input.idempotencyKey, actor), model: "gpt-5.6-sol" }
          : receipt("naia", input.idempotencyKey, actor),
      };
    } },
    moderator: { async plan(input) {
      calls.moderator += 1; actor += 1;
      const questions = options.question
        ? [{ questionId: "q-1", text: "Which parser?" }, ...(options.multipleQuestions ? [{ questionId: "q-2", text: "Which test?" }] : [])]
        : [];
      const moderatorReceipt = receipt("moderator", input.idempotencyKey, actor);
      if (options.rejectedActorResult) throw new IssueActorResultError("moderator JSON rejected", moderatorReceipt);
      return {
        plan: { workerTask: "Fix src/parser.ts", workerProfile: options.workerProfile ?? "balanced", acceptanceChecks: ["parser tests pass"], questions },
        receipt: options.malformedReceipt === "cached"
          ? { ...moderatorReceipt, cachedInputTokens: moderatorReceipt.inputTokens + 1 }
          : options.malformedReceipt === "cost"
            ? { ...moderatorReceipt, cost: { state: "measured", usd: Number.NaN, source: "fixture" } }
            : options.malformedReceipt === "unavailable"
              ? { ...moderatorReceipt, tokenCountsAvailable: false }
              : moderatorReceipt,
      };
    } },
    worker: { async execute(input) {
      calls.worker += 1; actor += 1;
      seenWorkerObligations = input.obligations;
      if (options.workerThrows) throw new Error("transport disappeared after dispatch");
      if (options.rejectedWorkerResult) throw new IssueActorResultError("worker policy rejected", receipt("worker", input.dispatchId, actor));
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
      if (options.verifierThrows) throw new Error("verifier transport failed");
      return {
        ok: !options.verificationFails,
        checks: [{ name: "parser tests pass", pass: !options.verificationFails }],
        receipt: receipt("verifier", options.badVerifierReceipt ? "wrong:verify:key" : input.idempotencyKey, actor),
      };
    } },
    reporter: { async report(input) {
      calls.reporter += 1; actor += 1;
      expect(input.events.map((event) => event.type)).toContain(options.verificationFails ? "verification_failed" : "verification_passed");
      const terminal = input.issue.state as "completed" | "failed";
      return {
        report: options.contradictoryReporter
          ? { state: "completed", summary: "verification remains pending", issueId: input.issue.issueId, changedFiles: ["fake-success.ts"], verificationPassed: false }
          : { state: terminal, summary: groundedIssueCommentary(input.issue, terminal), issueId: input.issue.issueId,
              changedFiles: input.issue.worker?.changedFiles ?? [], verificationPassed: input.issue.verification?.ok ?? null },
        receipt: receipt("reporter", input.idempotencyKey, actor),
      };
    } },
  };
  return { root, store, calls, get seenFacingText() { return seenFacingText; }, get seenWorkerObligations() { return seenWorkerObligations; }, orchestrator: new SingleIssueOrchestrator(deps), deps };
}

describe("UC-ORCH-001 single issue", () => {
  it("rejects empty or unsupported facing and moderator bindings before persistence", async () => {
    const h = harness();
    await expect(h.orchestrator.start({ ...request("bad-facing"), naiaBinding: { provider: "", model: "" } }))
      .rejects.toThrow("invalid facing or moderator binding");
    await expect(h.orchestrator.start({ ...request("bad-moderator"), moderatorBinding: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "extreme" } }))
      .rejects.toThrow("invalid facing or moderator binding");
    expect(() => h.orchestrator.snapshot("issue-0001")).toThrow("unknown issue");
    h.store.close();
  });

  it("keeps chat out of moderator and worker paths", async () => {
    const h = harness({ chat: true });
    const report = await h.orchestrator.start(request("chat-1", "오늘 어때?", []));
    expect(report).toMatchObject({ state: "chat", summary: "hello", changedFiles: [] });
    expect(h.calls).toEqual({ facing: 1, moderator: 0, worker: 0, verifier: 0, reporter: 0 });
    h.store.close();
  });

  it("fails closed when an actor receipt does not match its persisted binding", async () => {
    const h = harness({ badFacingBinding: true });
    const report = await h.orchestrator.start(request("bad-binding"));
    expect(report).toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
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
    expect(h.seenWorkerObligations).toEqual(["fix parser", "run tests"]);
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

  it("rejects a work classification that drops an intake-authoritative obligation", async () => {
    const h = harness({ droppedObligation: true });
    const report = await h.orchestrator.start(request("request-dropped-obligation"));
    expect(report).toMatchObject({ state: "failed" });
    expect(h.calls.moderator).toBe(0);
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("actor_result_rejected");
    expect(h.orchestrator.snapshot("issue-0001").requiredObligations).toEqual(["fix parser", "run tests"]);
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

  it("accepts moderator questions only in their presented order", async () => {
    const h = harness({ question: true, multipleQuestions: true });
    const first = await h.orchestrator.start(request("request-question-order"));
    expect(first.question?.questionId).toBe("q-1");
    await expect(h.orchestrator.answer("issue-0001", "q-2", "unit test"))
      .rejects.toBeInstanceOf(IssueQuestionMismatchError);
    const second = await h.orchestrator.answer("issue-0001", "q-1", "JSON parser");
    expect(second).toMatchObject({ state: "awaiting_user", question: { questionId: "q-2" } });
    const done = await h.orchestrator.answer("issue-0001", "q-2", "unit test");
    expect(done.state).toBe("completed");
    h.store.close();
  });

  it.each(["cached", "cost", "unavailable"] as const)("rejects internally inconsistent %s receipts", async (malformedReceipt) => {
    const h = harness({ malformedReceipt });
    const report = await h.orchestrator.start(request(`request-bad-receipt-${malformedReceipt}`));
    expect(report).toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
    expect(h.orchestrator.snapshot("issue-0001").receipts.map((item) => item.role)).toEqual(["naia"]);
    h.store.close();
  });

  it("persists a completed paid receipt when strict actor-result validation rejects the payload", async () => {
    const h = harness({ rejectedActorResult: true });
    const report = await h.orchestrator.start(request("request-rejected-actor-result"));
    expect(report).toMatchObject({ state: "failed", totalCost: { state: "measured", usd: 0.02 } });
    expect(h.orchestrator.snapshot("issue-0001").receipts.map((item) => item.role)).toEqual(["naia", "moderator"]);
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("actor_result_rejected");
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
    await expect(resumed.start({ ...request(), requiredObligations: ["fix parser"] }))
      .rejects.toBeInstanceOf(IssueRequestConflictError);
    await expect(resumed.start(request("request-1", "different task"))).rejects.toBeInstanceOf(IssueRequestConflictError);
    reopened.close();
  });

  it("coalesces concurrent starts for one request before persistence or actor dispatch", async () => {
    const h = harness();
    let releaseFacing!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFacing = resolve; });
    const classify = h.deps.facing.classify.bind(h.deps.facing);
    const orchestrator = new SingleIssueOrchestrator({
      ...h.deps,
      facing: { async classify(input) { await gate; return classify(input); } },
    });
    const first = orchestrator.start(request("request-concurrent"));
    const second = orchestrator.start(request("request-concurrent"));
    await expect(orchestrator.start(request("request-concurrent", "different task")))
      .rejects.toBeInstanceOf(IssueRequestConflictError);
    releaseFacing();
    expect(await Promise.all([first, second])).toEqual([await first, await first]);
    expect(h.calls).toEqual({ facing: 1, moderator: 1, worker: 1, verifier: 1, reporter: 1 });
    h.store.close();
  });

  it("joins an active durable execution claim across orchestrator instances", async () => {
    const h = harness();
    const secondStore = new SqliteIssueOrchestrationStore(join(h.root, "issues.db"));
    let releaseFacing!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFacing = resolve; });
    const classify = h.deps.facing.classify.bind(h.deps.facing);
    const gatedFacing = { async classify(input: Parameters<typeof classify>[0]) { await gate; return classify(input); } };
    const firstOrchestrator = new SingleIssueOrchestrator({ ...h.deps, store: h.store, facing: gatedFacing });
    const secondOrchestrator = new SingleIssueOrchestrator({ ...h.deps, store: secondStore, facing: gatedFacing });
    const first = firstOrchestrator.start(request("request-cross-instance"));
    const joined = secondOrchestrator.start(request("request-cross-instance"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFacing();
    const [firstReport, joinedReport] = await Promise.all([first, joined]);
    expect(joinedReport).toEqual(firstReport);
    expect(h.calls).toEqual({ facing: 1, moderator: 1, worker: 1, verifier: 1, reporter: 1 });
    secondStore.close();
    h.store.close();
  });

  it("abandons a lost lease and joins the successor instead of rejecting after a fenced save", async () => {
    const h = harness();
    const secondStore = new SqliteIssueOrchestrationStore(join(h.root, "issues.db"));
    let releaseFacing!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFacing = resolve; });
    const classify = h.deps.facing.classify.bind(h.deps.facing);
    const gatedFacing = { async classify(input: Parameters<typeof classify>[0]) { enteredResolve(); await gate; return classify(input); } };
    const firstOrchestrator = new SingleIssueOrchestrator({
      ...h.deps, store: h.store, facing: gatedFacing, executionLeaseMs: 10, executionPollMs: 5,
    });
    const successor = new SingleIssueOrchestrator({
      ...h.deps, store: secondStore, facing: gatedFacing, executionLeaseMs: 10, executionPollMs: 5,
    });
    const first = firstOrchestrator.start(request("request-expired-lease"));
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const successorReport = await successor.start(request("request-expired-lease"));
    expect(successorReport.state).toBe("outcome_unknown");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFacing();
    await expect(first).resolves.toEqual(successorReport);
    expect(h.calls.worker).toBe(0);
    secondStore.close();
    h.store.close();
  });

  it("treats a renewal exception as claim loss and suppresses every later local save", async () => {
    const h = harness();
    let releaseFacing!: () => void;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFacing = resolve; });
    const classify = h.deps.facing.classify.bind(h.deps.facing);
    const store = new Proxy(h.store, {
      get(target, property) {
        if (property === "renewExecution") return () => { throw new Error("sqlite busy during renewal"); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SingleIssueOrchestratorDeps["store"];
    const orchestrator = new SingleIssueOrchestrator({
      ...h.deps,
      store,
      executionLeaseMs: 10,
      facing: { async classify(input) { enteredResolve(); await gate; return classify(input); } },
    });
    const running = orchestrator.start(request("request-renewal-error"));
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFacing();
    await expect(running).resolves.toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
    expect(h.calls.worker).toBe(0);
    h.store.close();
  });

  it("atomically establishes one issue when two worker threads race request creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "single-issue-create-race-")); roots.push(root);
    const dbPath = join(root, "issues.db");
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const moduleUrl = new URL("../../dist/main/adapters/sqlite-issue-orchestration-store.js", import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { SqliteIssueOrchestrationStore } = await import(workerData.moduleUrl);
        const store = new SqliteIssueOrchestrationStore(workerData.dbPath);
        const view = new Int32Array(workerData.barrier);
        Atomics.add(view, 0, 1);
        parentPort.postMessage({ kind: "ready" });
        while (Atomics.load(view, 1) === 0) Atomics.wait(view, 1, 0);
        try {
          const result = store.createOrGet(workerData.request, workerData.input);
          parentPort.postMessage({ kind: "result", value: { created: result.created, issueId: result.snapshot.issueId, digest: result.snapshot.requestDigest } });
        } catch (error) {
          parentPort.postMessage({ kind: "result", value: { error: error instanceof Error ? error.message : String(error) } });
        } finally { store.close(); }
      })().catch((error) => parentPort.postMessage({ kind: "result", value: {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } }));
    `;
    const spawn = (issueId: string) => {
      let readyResolve!: () => void;
      let resultResolve!: (value: { created: boolean; issueId: string; digest: string; error?: string }) => void;
      const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
      const result = new Promise<{ created: boolean; issueId: string; digest: string; error?: string }>((resolve) => { resultResolve = resolve; });
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl, dbPath, barrier, request: request("request-create-race"), input: { issueId, requestDigest: "same-digest", now: "2026-08-01T00:00:00Z" } },
      });
      worker.on("message", (message: { kind: string; value?: { created: boolean; issueId: string; digest: string; error?: string } }) => {
        if (message.kind === "ready") readyResolve();
        if (message.kind === "result") { readyResolve(); resultResolve(message.value!); }
      });
      worker.once("error", (error) => { readyResolve(); resultResolve({ created: false, issueId: "", digest: "", error: error.message }); });
      return { ready, result };
    };
    const first = spawn("issue-thread-1");
    const second = spawn("issue-thread-2");
    await Promise.all([first.ready, second.ready]);
    Atomics.store(new Int32Array(barrier), 1, 1);
    Atomics.notify(new Int32Array(barrier), 1, 2);
    const results = await Promise.all([first.result, second.result]);
    expect(results.every((result) => !result.error), JSON.stringify(results)).toBe(true);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.issueId)).size).toBe(1);
    expect(results.every((result) => result.digest === "same-digest")).toBe(true);
  });

  it("expires execution claims atomically and fences stale owners from saving", () => {
    const h = harness();
    const accepted = h.store.create(request("request-lease-expiry"), {
      issueId: "issue-0001", requestDigest: "digest", now: "2026-08-01T00:00:00Z",
    });
    expect(h.store.tryAcquireExecution("issue-0001", "owner-1", 100, 200)).toBe(true);
    expect(h.store.tryAcquireExecution("issue-0001", "owner-2", 150, 250)).toBe(false);
    expect(h.store.renewExecution("issue-0001", "owner-1", 201, 400)).toBe(false);
    expect(h.store.tryAcquireExecution("issue-0001", "owner-2", 201, 300)).toBe(true);
    expect(h.store.renewExecution("issue-0001", "owner-1", 202, 400)).toBe(false);
    expect(() => h.store.save({
      expectedVersion: accepted.version,
      snapshot: { ...accepted, state: "classifying", updatedAt: "2026-08-01T00:00:01Z" },
      eventType: "stale_owner_write",
      executionOwnerId: "owner-1",
      executionNowMs: 202,
    })).toThrow(IssueStoreExecutionClaimError);
    h.store.releaseExecution("issue-0001", "owner-2");
    h.store.close();
  });

  it("lets a durable cancellation request win over a stale pre-dispatch transition", () => {
    const h = harness();
    const accepted = h.store.create(request("request-cancel-save-race"), {
      issueId: "issue-0001", requestDigest: "digest", now: "2026-08-01T00:00:00Z",
    });
    const requested = h.store.requestCancellation("issue-0001", "2026-08-01T00:00:01Z");
    const staleSave = h.store.save({
      expectedVersion: accepted.version,
      snapshot: { ...accepted, state: "classifying", updatedAt: "2026-08-01T00:00:02Z" },
      eventType: "facing_dispatched",
    });
    expect(staleSave).toEqual(requested);
    expect(h.store.events("issue-0001").map((event) => event.type)).toEqual(["issue_accepted", "cancellation_requested"]);
    h.store.close();
  });

  it("rejects immutable identity drift and every post-terminal snapshot mutation", async () => {
    const h = harness({ question: true });
    await h.orchestrator.start(request("request-immutable"));
    const pending = h.orchestrator.snapshot("issue-0001");
    expect(() => h.store.save({
      expectedVersion: pending.version,
      snapshot: { ...pending, requestDigest: "changed", updatedAt: "2026-08-01T00:02:00Z" },
      eventType: "invalid_identity_change",
    })).toThrow(IssueStoreImmutableFieldError);
    const done = await h.orchestrator.answer("issue-0001", "q-1", "JSON parser");
    const terminal = h.orchestrator.snapshot(done.issueId!);
    expect(() => h.store.save({
      expectedVersion: terminal.version,
      snapshot: { ...terminal, updatedAt: "2026-08-01T00:03:00Z" },
      eventType: "invalid_terminal_change",
    })).toThrow(IssueStoreTerminalMutationError);
    h.store.close();
  });

  it("allows dispatch id assignment exactly once and rejects later drift", async () => {
    const h = harness({ question: true });
    await h.orchestrator.start(request("request-dispatch-stable"));
    const pending = h.orchestrator.snapshot("issue-0001");
    const assigned = h.store.save({
      expectedVersion: pending.version,
      snapshot: { ...pending, dispatchId: "issue-0001:dispatch:1", updatedAt: "2026-08-01T00:02:00Z" },
      eventType: "dispatch_assigned_fixture",
    });
    expect(() => h.store.save({
      expectedVersion: assigned.version,
      snapshot: { ...assigned, dispatchId: "issue-0001:dispatch:2", updatedAt: "2026-08-01T00:03:00Z" },
      eventType: "dispatch_changed_fixture",
    })).toThrow(IssueStoreImmutableFieldError);
    h.store.close();
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
    expect(await question.orchestrator.cancel(pending.issueId!)).toMatchObject({ state: "cancelled" });
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

  it("persists a paid worker receipt when post-call policy rejects its result", async () => {
    const h = harness({ rejectedWorkerResult: true });
    const report = await h.orchestrator.start(request("request-worker-result-rejected"));
    expect(report).toMatchObject({ state: "failed", totalCost: { state: "measured", usd: 0.03 } });
    expect(h.orchestrator.snapshot("issue-0001").receipts.map((item) => item.role)).toEqual(["naia", "moderator", "worker"]);
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("actor_result_rejected");
    h.store.close();
  });

  it.each(["facing", "moderator"] as const)("cancels a slow pre-dispatch %s actor and fences its late path", async (stage) => {
    const h = harness();
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const blocked = async (input: { signal: AbortSignal }): Promise<never> => {
      enteredResolve();
      return new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(new Error("actor aborted")), { once: true }));
    };
    const orchestrator = new SingleIssueOrchestrator({
      ...h.deps,
      ...(stage === "facing" ? { facing: { classify: blocked } } : {}),
      ...(stage === "moderator" ? { moderator: { plan: blocked } } : {}),
    });
    const running = orchestrator.start(request(`request-cancel-${stage}`));
    await entered;
    const cancelled = await orchestrator.cancel("issue-0001");
    expect(cancelled).toMatchObject({ state: "cancelled", totalCost: { state: "unavailable" } });
    expect(await running).toEqual(cancelled);
    expect(h.calls.worker).toBe(0);
    expect(h.store.events("issue-0001").map((event) => event.type)).toContain("cancellation_requested");
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("issue_cancelled");
    h.store.close();
  });

  it("binds user-facing commentary exactly to persisted failure evidence", async () => {
    const h = harness({ verificationFails: true });
    const report = await h.orchestrator.start(request("request-failed-report"));
    expect(report).toMatchObject({
      state: "failed", summary: "state=failed; changedFiles=1; verification=failed",
      naiaCommentary: "Failed. Changed files: src/parser.ts. Verification: failed.",
      changedFiles: ["src/parser.ts"], verificationPassed: false,
    });
    h.store.close();
  });

  it("rejects reporter prose or fields that contradict persisted evidence", async () => {
    const h = harness({ contradictoryReporter: true });
    const report = await h.orchestrator.start(request("request-contradictory-report"));
    expect(report).toMatchObject({
      state: "failed", summary: "state=failed; changedFiles=1; verification=passed", verificationPassed: true,
    });
    expect(report).not.toHaveProperty("naiaCommentary");
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("actor_result_rejected");
    expect(h.orchestrator.snapshot("issue-0001").receipts.at(-1)?.role).toBe("reporter");
    h.store.close();
  });

  it.each(["throws", "bad-receipt"] as const)("terminalizes an unavailable verifier outcome when it %s", async (failure) => {
    const h = harness({ verifierThrows: failure === "throws", badVerifierReceipt: failure === "bad-receipt" });
    const report = await h.orchestrator.start(request(`request-verifier-${failure}`));
    expect(report).toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
    expect(h.calls.reporter).toBe(0);
    expect(h.store.events("issue-0001").at(-1)?.type).toBe("actor_outcome_unknown");
    expect(h.orchestrator.snapshot("issue-0001").state).toBe("outcome_unknown");
    h.store.close();
  });

  it("redacts credential-shaped text before durable persistence", async () => {
    const h = harness({ chat: true });
    await h.orchestrator.start(request("request-secret", "rotate api_key=super-secret-value-now"));
    expect(h.seenFacingText).toBe("rotate api_key=[REDACTED]");
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

  it("fails closed before actor dispatch when a legacy snapshot lacks the obligation contract", async () => {
    const h = harness();
    h.store.create(request("request-legacy-obligations"), {
      issueId: "issue-0001", requestDigest: "legacy-digest", now: "2026-08-01T00:00:00Z",
    });
    const dbPath = join(h.root, "issues.db");
    h.store.close();

    const db = new Database(dbPath);
    const row = db.prepare("SELECT snapshot_json FROM issue_orchestration_snapshots WHERE issue_id=?")
      .get("issue-0001") as { snapshot_json: string };
    const legacy = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    delete legacy.requiredObligations;
    db.prepare("UPDATE issue_orchestration_snapshots SET snapshot_json=? WHERE issue_id=?")
      .run(JSON.stringify(legacy), "issue-0001");
    db.close();

    const reopened = new SqliteIssueOrchestrationStore(dbPath);
    const restarted = new SingleIssueOrchestrator({ ...h.deps, store: reopened });
    await expect(restarted.resume("issue-0001")).rejects.toBeInstanceOf(IssueStoreSnapshotContractError);
    expect(h.calls).toEqual({ facing: 0, moderator: 0, worker: 0, verifier: 0, reporter: 0 });
    reopened.close();
  });

  it("does not replay verification after restart without exact reconciliation", async () => {
    const h = harness({ question: true });
    await h.orchestrator.start(request("request-verifier-restart"));
    const pending = h.orchestrator.snapshot("issue-0001");
    h.store.save({
      expectedVersion: pending.version,
      snapshot: {
        ...pending,
        state: "verifying",
        dispatchId: "issue-0001:dispatch:1",
        plan: { workerTask: "fix", workerProfile: "balanced", acceptanceChecks: ["parser tests pass"], questions: [] },
        worker: {
          ok: true, summary: "done", worktreePath: "/managed/issue-0001", changedFiles: ["src/parser.ts"],
          receipt: receipt("worker", "issue-0001:dispatch:1", 10),
        },
        updatedAt: "2026-08-01T00:01:00Z",
      },
      eventType: "verification_dispatched_fixture",
    });
    h.store.close();
    const reopened = new SqliteIssueOrchestrationStore(join(h.root, "issues.db"));
    let verifierCalls = 0;
    const restarted = new SingleIssueOrchestrator({
      ...h.deps,
      store: reopened,
      verifier: { async verify() { verifierCalls += 1; throw new Error("must not replay"); } },
    });
    expect(await restarted.resume("issue-0001")).toMatchObject({ state: "outcome_unknown", totalCost: { state: "unavailable" } });
    expect(verifierCalls).toBe(0);
    expect(reopened.events("issue-0001").at(-1)?.type).toBe("actor_outcome_unknown");
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

  it("rejects cancellation after worker dispatch", async () => {
    const h = harness();
    const accepted = h.store.create(request("request-cancel-race"), {
      issueId: "issue-0001", requestDigest: "digest", now: "2026-08-01T00:00:00Z",
    });
    h.store.save({
      expectedVersion: accepted.version,
      snapshot: { ...accepted, state: "reporter_running", updatedAt: "2026-08-01T00:00:01Z" },
      eventType: "reporter_dispatched",
    });
    await expect(h.orchestrator.cancel("issue-0001")).rejects.toThrow("already dispatched");
    h.store.close();
  });
});
